local function build(names, map, list)
  local s = table.concat(names, ", ")
  local v = map.x
  table.insert(list, s)
  table.sort(list)
  for i, x in ipairs(list) do v = v .. x:upper() end
  for k, x in pairs(map) do v = v .. k end
  return #list + select("#", s)
end
