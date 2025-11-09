# ai_service.py
import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Callable, Coroutine

# ----- Task / Request object -----
@dataclass
class AIRequest:
    id: str
    prompt: str
    model: str
    timeout: float = 30.0
    retries: int = 2
    attempt: int = 0
    metadata: Dict[str, Any] = field(default_factory=dict)
    # get_event_loop was deprecate, ensures Future is created in running loop
    result_future: asyncio.Future = field(default_factory=lambda: asyncio.get_running_loop().create_future())

# ----- Adapter interface -----
class AsyncModelAdapter:
    """Implementations must be awaitable and respect timeouts externally."""
    async def generate(self, prompt: str, timeout: Optional[float] = None, **kwargs) -> str:
        raise NotImplementedError

# ----- Example adapters (stubs) -----
# class OllamaAdapter(AsyncModelAdapter):
#     def __init__(self, endpoint: str, concurrency: int = 1):
#         self.endpoint = endpoint
#         self.semaphore = asyncio.Semaphore(concurrency)
#         # If using a synchronous client, wrap it with run_in_executor

#     async def generate(self, prompt: str, timeout: Optional[float] = None, **kwargs) -> str:
#         async with self.semaphore:
#             await asyncio.sleep(0.01)  # simulate I/O latency
#             # Replace with real HTTP/CLI call to Ollama here
#             return f"[ollama] response to: {prompt}"

class GeminiAdapter(AsyncModelAdapter):
    def __init__(self, api_key: str, concurrency: int = 2):
        self.api_key = api_key
        self.semaphore = asyncio.Semaphore(concurrency)

    async def generate(self, prompt: str, timeout: Optional[float] = None, **kwargs) -> str:
        async with self.semaphore:
            
            await asyncio.sleep(0.02)  # simulate I/O

            from google import genai

            client = genai.Client()

            response = client.models.generate_content(
                model="gemini-2.5-flash",
                contents="Within this radius",
            )

            print(response.text)
        
            return f"[gemini] response to: {prompt}"
        

class LocalProcessAdapter(AsyncModelAdapter):
    def __init__(self, cmd: str, concurrency: int = 1):
        self.cmd = cmd
        self.semaphore = asyncio.Semaphore(concurrency)

    async def generate(self, prompt: str, timeout: Optional[float] = None, **kwargs) -> str:
        async with self.semaphore:
            loop = asyncio.get_running_loop()
            # Run any blocking process in executor if necessary
            def sync_work():
                time.sleep(0.05)
                return f"[local-proc] response to: {prompt}"
            return await loop.run_in_executor(None, sync_work)

# ----- Dispatcher & Worker pool -----
class AIService:
    def __init__(self, adapters: Dict[str, AsyncModelAdapter], worker_count: int = 4):
        self.adapters = adapters
        self.queue: asyncio.Queue[AIRequest] = asyncio.Queue()
        self.worker_count = worker_count
        self.workers = []
        self.stopping = asyncio.Event()
        # Basic metrics
        self.metrics = {"processed": 0, "failed": 0, "avg_latency": 0.0}

    async def start(self):
        for i in range(self.worker_count):
            w = asyncio.create_task(self._worker_loop(i))
            self.workers.append(w)

    async def stop(self):
        self.stopping.set()

        for _ in range(self.worker_count):
          await self.queue.put(None)


        # Wait until queue drained or force stop after timeout
        await asyncio.gather(*self.workers, return_exceptions=True)

    async def submit(self, prompt: str, model: str = "ollama", timeout: float = 30.0, retries: int = 2, metadata: Dict[str, Any] = None) -> str:
        rid = str(uuid.uuid4())
        req = AIRequest(id=rid, prompt=prompt, model=model, timeout=timeout, retries=retries, metadata=metadata or {})
        await self.queue.put(req)
        return await req.result_future

    async def _worker_loop(self, index: int):
      while True:
        try:
            req = await self.queue.get()
        except Exception:
            continue
        
        # Sentinel means: shut down immediately
        if req is None:
            self.queue.task_done()
            break

        start = time.time()
        try:
            resp = await self._process_request(req)
            latency = time.time() - start

            # Prevents race conditions
            self._metrics_lock = asyncio.Lock()
            async with self._metrics_lock:
              self.metrics["processed"] += 1
              self.metrics["avg_latency"] = (
                  (self.metrics["avg_latency"] * (self.metrics["processed"] - 1) + latency)
                  / self.metrics["processed"]
              )

            if not req.result_future.done():
                req.result_future.set_result({"id": req.id, "response": resp, "latency": latency})
        except Exception as e:
            self.metrics["failed"] += 1
            if not req.result_future.done():
                # req.result_future.set_exception(e)
                req.result_future.set_result({
                    "id": req.id,
                    "error": {
                        "type": "Timeout",
                        "message": str(e),
                        "attempt": req.attempt
                    }
                })
        finally:
            self.queue.task_done()
            

    # async def _worker_loop(self, index: int):
    #     while not self.stopping.is_set():
    #         try:
    #             req: AIRequest = await asyncio.wait_for(self.queue.get(), timeout=1.0)
    #         except asyncio.TimeoutError:
    #             continue
    #         start = time.time()
    #         try:
    #             resp = await self._process_request(req)
    #             latency = time.time() - start
    #             # update metrics
    #             self.metrics["processed"] += 1
    #             # running average
    #             self.metrics["avg_latency"] = (self.metrics["avg_latency"] * (self.metrics["processed"] - 1) + latency) / self.metrics["processed"]
    #             if not req.result_future.done():
    #                 req.result_future.set_result({"id": req.id, "response": resp, "latency": latency})
    #         except Exception as e:
    #             self.metrics["failed"] += 1
    #             if not req.result_future.done():
    #                 req.result_future.set_exception(e)
    #         finally:
    #             self.queue.task_done()

    async def _process_request(self, req: AIRequest) -> str:
        # choose adapter
        adapter = self.adapters.get(req.model)
        if adapter is None:
            raise RuntimeError(f"Unknown model adapter: {req.model}")
        last_exc = None
        for attempt in range(req.retries + 1):
            req.attempt = attempt
            try:
                # per-request timeout
                return await asyncio.wait_for(adapter.generate(req.prompt, timeout=req.timeout, metadata=req.metadata), timeout=req.timeout)
            except asyncio.TimeoutError as te:
                last_exc = te
            except Exception as e:
                last_exc = e
            # simple backoff
            await asyncio.sleep(0.5 * (2 ** attempt))
        raise RuntimeError(f"All retries failed for {req.id}: {last_exc}")

# ----- Simple test harness -----
async def main_demo():
    adapters = {
        "ollama": OllamaAdapter(endpoint="http://localhost:11434", concurrency=2),
        "gemini": GeminiAdapter(api_key="dummy", concurrency=2),
        "local": LocalProcessAdapter(cmd="./local_model", concurrency=1),
    }
    svc = AIService(adapters=adapters, worker_count=6)
    await svc.start()

    async def make_query(prompt, model):
        try:
            resp = await svc.submit(prompt, model=model, timeout=5.0, retries=1)
            print("GOT:", resp)
        except Exception as e:
            print("ERR:", e)

    tasks = []
    for i in range(20):
        model = "ollama" if i % 3 == 0 else ("gemini" if i % 3 == 1 else "local")
        tasks.append(asyncio.create_task(make_query(f"Question {i}", model)))

    await asyncio.gather(*tasks)
    await svc.stop()
    print("Metrics:", svc.metrics)

if __name__ == "__main__":
    asyncio.run(main_demo())