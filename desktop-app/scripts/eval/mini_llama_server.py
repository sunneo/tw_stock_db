# 本機 qwen3-0.6b 的 OpenAI 相容小服務（只用已安裝的 llama_cpp_python）：python3 -I scripts/eval/mini_llama_server.py <gguf 路徑> <埠>
# 供 scripts/eval/stack_consistency.js、code_loop_bench.js --backend http 使用；enable_thinking:false 會在最後一則 user 訊息後加 /no_think。
import json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from llama_cpp import Llama

MODEL = sys.argv[1]
PORT = int(sys.argv[2])
llm = Llama(model_path=MODEL, n_ctx=4096, n_threads=12, verbose=False)
lock = threading.Lock()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        n = int(self.headers.get('content-length', 0))
        req = json.loads(self.rfile.read(n) or b'{}')
        msgs = req.get('messages', [])
        think = (req.get('chat_template_kwargs') or {}).get('enable_thinking')
        if think is False and msgs:
            msgs = [dict(m) for m in msgs]
            for m in reversed(msgs):
                if m.get('role') == 'user':
                    m['content'] = m['content'] + ' /no_think'
                    break
        with lock:
            out = llm.create_chat_completion(messages=msgs, max_tokens=req.get('max_tokens', 600), temperature=req.get('temperature', 0))
        c = out['choices'][0]['message']
        c['content'] = (c.get('content') or '').replace('<think>\n\n</think>\n\n', '')
        b = json.dumps(out).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)


ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
