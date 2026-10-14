def build(names, h, list, io)
  s = names.join(", ")
  v = h.fetch(:x, 1)
  h.merge!(a: 1)
  list.push(s)
  list.each { |x| x.strip }
  t = list.map(&:to_s).select { |x| x.size > 1 }.first
  io.write("x")
  io.close
  s.split(",").size + t.to_s.length
end
