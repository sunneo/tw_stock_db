#include <fstream>
#include <iostream>
#include <thread>
#include <mutex>
#include <vector>
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <memory>
#include <regex>

// Read a whole file into a string.
std::string read_all(const std::string& path) {
    std::ifstream in(path);
    if (!in.is_open()) { throw std::runtime_error("open failed: " + path); }
    std::string line, out;
    while (std::getline(in, line)) { out += line + "\n"; }
    return out;
}

class Worker {
public:
    // Start a background thread that sorts the data under a lock.
    void start(std::vector<int> data) {
        std::lock_guard<std::mutex> g(mu_);
        std::thread t([data]() mutable { std::sort(data.begin(), data.end()); });
        t.detach();
        auto now = std::chrono::steady_clock::now();
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        std::cout << "started" << std::endl;
    }
    void save(const std::string& dir) {
        std::filesystem::create_directories(dir);
        auto p = std::make_unique<int>(3);
        std::regex re("a+");
        for (auto& x : items_) { x += *p; }
    }
private:
    std::mutex mu_;
    std::vector<int> items_;
};
