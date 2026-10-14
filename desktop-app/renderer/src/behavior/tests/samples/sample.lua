local json = require("json")
local socket = require("socket")
local M = {}

-- Read a config file and decode it
function M.load(path, strict)
  local f = io.open(path, "r")
  if not f then
    error("missing " .. path)
  elseif strict then
    return nil
  else
    print("ok")
  end
  local text = f:read("*a")
  f:close()
  for i = 1, 3 do
    M.count = M.count + i
  end
  for k, v in pairs(M.items) do
    print(string.format("%s=%s", k, v))
  end
  while M.count > 0 do
    M.count = M.count - 1
  end
  local ok, err = pcall(function() return json.decode(text) end)
  return ok
end

-- Run a shell command and fetch a URL
function M:fetch(host)
  local c = socket.tcp()
  c:connect(host, 80)
  c:send("GET / HTTP/1.0\r\n\r\n")
  local resp = c:receive("*a")
  c:close()
  os.execute("ls -l")
  local p = io.popen("uname -a")
  local home = os.getenv("HOME")
  local now = os.time()
  table.insert(self.items, resp)
  math.randomseed(now)
  os.remove("/tmp/x")
  coroutine.wrap(function() coroutine.yield(1) end)()
  return resp, home
end

local function helper(x) return x * 2 end
return M
