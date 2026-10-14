require 'json'
require 'net/http'
require 'open3'

class Loader
  def initialize(path)
    @path = path
  end

  # Read the config file and parse it as JSON.
  def load(strict = false)
    unless File.exist?(@path)
      raise ArgumentError, "missing #{@path}"
    end
    text = File.read(@path)
    data = JSON.parse(text)
    data.each do |k, v|
      puts "#{k}=#{v}"
    end
    for i in 0..3 do
      @count += i
    end
    while @count > 0
      @count -= 1
    end
    case @mode
    when :a then log("a")
    else log("other")
    end
    return data if strict
    data
  end

  # Download a URL and shell out for the checksum.
  def fetch(url)
    uri = URI.parse(url)
    res = Net::HTTP.get(uri)
    out, status = Open3.capture2("sha256sum", stdin_data: res)
    File.write("/tmp/out.txt", out)
    t = Thread.new { sleep 1 }
    t.join
    now = Time.now
    home = ENV['HOME']
    system("ls -l")
    begin
      Dir.mkdir("/tmp/x")
    rescue StandardError => e
      warn e.message
    ensure
      FileUtils.rm_rf("/tmp/x")
    end
    [res, now, home]
  end

  def self.build(opts)
    new(opts[:path])
  end
end
