#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <string>
#include <stdexcept>
#include <vector>

// 原生验收同时可在 Windows 和 Wine 执行；Wine 结果不能代替 Windows 实机验收。
static void check(bool ok, const char* message) {
  if (!ok) throw std::runtime_error(std::string(message) + ": " + std::to_string(GetLastError()));
}
static std::wstring self() {
  wchar_t path[32768];
  check(GetModuleFileNameW(nullptr, path, 32768) != 0, "self path");
  return path;
}
static PROCESS_INFORMATION launch(std::wstring command, HANDLE input = INVALID_HANDLE_VALUE, HANDLE output = INVALID_HANDLE_VALUE) {
  STARTUPINFOW si{};
  si.cb = sizeof(si);
  if (input != INVALID_HANDLE_VALUE) {
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = input;
    si.hStdOutput = output == INVALID_HANDLE_VALUE ? GetStdHandle(STD_OUTPUT_HANDLE) : output;
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  }
  PROCESS_INFORMATION pi{};
  check(CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE, 0, nullptr, nullptr, &si, &pi), "launch");
  CloseHandle(pi.hThread);
  return pi;
}
static std::string readLine(HANDLE pipe) {
  std::string result;
  for (;;) {
    char c; DWORD count;
    check(ReadFile(pipe, &c, 1, &count, nullptr) && count == 1, "control read");
    if (c == '\n') return result;
    result += c;
    check(result.size() < 1024, "bounded control frame");
  }
}
static void writeLine(HANDLE pipe, const char* line) {
  DWORD count;
  check(WriteFile(pipe, line, static_cast<DWORD>(strlen(line)), &count, nullptr), "control write");
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc > 2 && std::wstring(argv[1]) == L"watch") {
      std::vector<HANDLE> processes;
      for (int i = 2; i < argc; ++i) {
        auto handle = OpenProcess(SYNCHRONIZE, FALSE, wcstoul(argv[i], nullptr, 10));
        check(handle != nullptr, "watch process identity"); processes.push_back(handle);
      }
      std::puts("watching"); std::fflush(stdout);
      for (auto handle : processes) {
        check(WaitForSingleObject(handle, 4000) == WAIT_OBJECT_0, "Host loss must terminate owned process");
        CloseHandle(handle);
      }
      return 0;
    }
    if (argc > 1 && std::wstring(argv[1]) == L"fixture") {
      const std::wstring mode = argv[2];
      if (mode == L"descendant") { Sleep(INFINITE); return 0; }
      if (mode == L"tree" || mode == L"root-exit") {
      auto pi = launch(L"\"" + self() + L"\" fixture descendant");
        // 独立进程句柄由验收父进程打开；检查 Job 清空不能只检查根退出。
        std::printf("descendant %lu\n", pi.dwProcessId); std::fflush(stdout);
        CloseHandle(pi.hProcess);
        if (mode == L"root-exit") {
          char c; DWORD count;
          while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), &c, 1, &count, nullptr) && count) {}
          return 0;
        }
      }
      if (mode == L"graceful") {
        char buffer[128]; DWORD count;
        while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer, sizeof(buffer), &count, nullptr) && count) {}
        Sleep(1450);
        return 0;
      }
      Sleep(INFINITE); return 0;
    }
    check(argc == 2, "usage: acceptance.exe helper.exe");
    struct UnrelatedProcess {
      HANDLE handle;
      ~UnrelatedProcess() { TerminateProcess(handle, 0); WaitForSingleObject(handle, 1000); CloseHandle(handle); }
    } unrelated{launch(L"\"" + self() + L"\" fixture descendant").hProcess};
    for (const auto mode : {L"graceful", L"tree", L"root-exit", L"control-loss", L"helper-loss", L"cancel", L"ownership-failure"}) {
      const auto name = L"\\\\.\\pipe\\zcode-job-acceptance-" + std::to_wstring(GetCurrentProcessId()) + L"-" + mode;
      HANDLE control = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE | PIPE_WAIT, 1, 4096, 4096, 0, nullptr);
      check(control != INVALID_HANDLE_VALUE, "create control");
      SECURITY_ATTRIBUTES sa{sizeof(sa), nullptr, TRUE};
      HANDLE input, writer, outputReader, output;
      check(CreatePipe(&outputReader, &output, &sa, 0), "stdout pipe");
      SetHandleInformation(outputReader, HANDLE_FLAG_INHERIT, 0);
      check(CreatePipe(&input, &writer, &sa, 0), "stdin pipe");
      SetHandleInformation(writer, HANDLE_FLAG_INHERIT, 0);
      const std::wstring fixture = std::wstring(mode) == L"graceful" ? L"graceful" : std::wstring(mode) == L"root-exit" ? L"root-exit" : L"tree";
      const auto jobName = L"Local\\zcode-job-test-" + std::to_wstring(GetCurrentProcessId()) + L"-" + mode;
      HANDLE conflictingJob = std::wstring(mode) == L"ownership-failure" ? CreateJobObjectW(nullptr, jobName.c_str()) : nullptr;
      auto pi = launch(L"\"" + std::wstring(argv[1]) + L"\" " + name + L" " + std::to_wstring(GetCurrentProcessId()) + L" " + jobName + L" \"" + self() + L"\" fixture " + fixture, input, output);
      CloseHandle(input);
      CloseHandle(output);
      check(ConnectNamedPipe(control, nullptr) || GetLastError() == ERROR_PIPE_CONNECTED, "connect control");
      if (conflictingJob) {
        check(WaitForSingleObject(pi.hProcess, 2000) == WAIT_OBJECT_0, "reject Job ownership failure");
        DWORD code; check(GetExitCodeProcess(pi.hProcess, &code) && code != 0, "Job failure must fail startup");
        DWORD available = 0;
        const BOOL readable = PeekNamedPipe(outputReader, nullptr, 0, nullptr, &available, nullptr);
        check((readable && available == 0) || (!readable && GetLastError() == ERROR_BROKEN_PIPE), "failed ownership must not execute CLI");
        CloseHandle(conflictingJob); CloseHandle(pi.hProcess); CloseHandle(control); CloseHandle(writer); CloseHandle(outputReader);
        std::puts("PASS ownership failure rejects CLI execution"); continue;
      }
      const auto ready = readLine(control);
      check(ready.rfind("ready ", 0) == 0, "ready");
      const DWORD rootPid = std::stoul(ready.substr(6));
      HANDLE root = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, rootPid);
      check(root != nullptr, "root handle");
      DWORD available = 0;
      check(PeekNamedPipe(outputReader, nullptr, 0, nullptr, &available, nullptr) && available == 0, "CLI must stay suspended before start");
      HANDLE descendant = nullptr;
      if (std::wstring(mode) != L"cancel") {
        writeLine(control, "start\n");
        check(readLine(control) == "started", "started");
        if (fixture != L"graceful") {
          const auto line = readLine(outputReader);
          check(line.rfind("descendant ", 0) == 0, "descendant identity");
          descendant = OpenProcess(SYNCHRONIZE, FALSE, std::stoul(line.substr(11)));
          check(descendant != nullptr, "capture descendant handle before cleanup");
        }
      }
      const auto begin = GetTickCount64();
      if (std::wstring(mode) == L"control-loss" || std::wstring(mode) == L"cancel") {
        CloseHandle(control); control = INVALID_HANDLE_VALUE;
      } else if (std::wstring(mode) == L"helper-loss") {
        check(TerminateProcess(pi.hProcess, 91), "kill helper");
      } else {
        CloseHandle(writer); writer = INVALID_HANDLE_VALUE;
        if (std::wstring(mode) != L"root-exit") writeLine(control, "close\n");
        std::string line;
        do {
          line = readLine(control);
          if (std::wstring(mode) == L"graceful" && line.rfind("root ", 0) == 0)
            check(line == "root 0", "graceful root was forcibly killed");
        } while (line != "empty");
      }
      if (descendant) { check(WaitForSingleObject(descendant, 4000) == WAIT_OBJECT_0, "descendant must exit"); CloseHandle(descendant); }
      check(WaitForSingleObject(root, 4000) == WAIT_OBJECT_0, "root must exit");
      check(WaitForSingleObject(pi.hProcess, 4000) == WAIT_OBJECT_0, "helper must exit");
      if (std::wstring(mode) == L"graceful") check(GetTickCount64() - begin >= 1400, "full graceful window");
      auto probe = launch(L"\"" + std::wstring(argv[1]) + L"\" --check-empty " + jobName);
      check(WaitForSingleObject(probe.hProcess, 4000) == WAIT_OBJECT_0, "Job probe exits");
      DWORD probeCode; check(GetExitCodeProcess(probe.hProcess, &probeCode) && probeCode == 0, "kernel Job empty probe");
      CloseHandle(probe.hProcess);
      check(WaitForSingleObject(unrelated.handle, 0) == WAIT_TIMEOUT, "unrelated process must survive Job cleanup");
      std::printf("PASS %ls elapsed=%llu ms\n", mode, GetTickCount64() - begin);
      if (writer != INVALID_HANDLE_VALUE) CloseHandle(writer);
      if (control != INVALID_HANDLE_VALUE) CloseHandle(control);
      CloseHandle(root); CloseHandle(pi.hProcess); CloseHandle(outputReader);
    }
    return 0;
  } catch (const std::exception& error) { std::fprintf(stderr, "FAIL %s\n", error.what()); return 1; }
}
