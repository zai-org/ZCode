#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <tlhelp32.h>
#include <cstdio>
#include <cwchar>
#include <string>
#include <vector>

namespace {
struct Handle {
  HANDLE value;
  explicit Handle(HANDLE handle) : value(handle) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

void report(const char* stage, DWORD pid, DWORD error = 0) {
  char message[128];
  const int size = std::snprintf(message, sizeof(message), "stage=%s pid=%lu win32-error=%lu\n", stage, pid, error);
  if (size <= 0) return;
  std::fputs(message, stdout);
  std::fflush(stdout);
  // 修复原因：诊断日志被占用或不可写时，不能改变进程检查结果。
  wchar_t temp[MAX_PATH];
  DWORD length = GetTempPathW(MAX_PATH, temp);
  if (length == 0 || length >= MAX_PATH) return;
  const std::wstring path = std::wstring(temp) + L"ZCode-process-cleanup.log";
  Handle log(CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                         nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (log.value == INVALID_HANDLE_VALUE) return;
  DWORD written = 0;
  WriteFile(log.value, message, static_cast<DWORD>(size), &written, nullptr);
}

bool imagePath(HANDLE process, std::wstring& path, DWORD& error) {
  std::vector<wchar_t> buffer(32768);
  DWORD length = static_cast<DWORD>(buffer.size());
  if (!QueryFullProcessImageNameW(process, 0, buffer.data(), &length)) {
    error = GetLastError();
    return false;
  }
  path.assign(buffer.data(), length);
  return true;
}

bool exited(HANDLE process) {
  DWORD code = STILL_ACTIVE;
  return GetExitCodeProcess(process, &code) && code != STILL_ACTIVE;
}

bool sameProcess(HANDLE first, HANDLE second, DWORD& error) {
  FILETIME firstCreation{}, firstExit{}, firstKernel{}, firstUser{};
  FILETIME secondCreation{}, secondExit{}, secondKernel{}, secondUser{};
  if (!GetProcessTimes(first, &firstCreation, &firstExit, &firstKernel, &firstUser) ||
      !GetProcessTimes(second, &secondCreation, &secondExit, &secondKernel, &secondUser)) {
    error = GetLastError();
    return false;
  }
  if (firstCreation.dwLowDateTime != secondCreation.dwLowDateTime ||
      firstCreation.dwHighDateTime != secondCreation.dwHighDateTime) {
    error = ERROR_INVALID_DATA;
    return false;
  }
  return true;
}

bool samePath(const std::wstring& left, const std::wstring& right) {
  return _wcsicmp(left.c_str(), right.c_str()) == 0;
}

int scan(const std::wstring& expected, bool terminate) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (snapshot.value == INVALID_HANDLE_VALUE) {
    report("enumerate-failed", 0, GetLastError());
    return 2;
  }
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  if (!Process32FirstW(snapshot.value, &entry)) {
    DWORD error = GetLastError();
    if (error == ERROR_NO_MORE_FILES) return 0;
    report("enumerate-failed", 0, error);
    return 2;
  }
  const wchar_t* name = wcsrchr(expected.c_str(), L'\\');
  name = name ? name + 1 : expected.c_str();
  do {
    if (_wcsicmp(entry.szExeFile, name) != 0) continue;
    const DWORD pid = entry.th32ProcessID;
    // 修复原因：其他目录的同名进程可能拒绝终止权限；识别前只申请查询权限。
    Handle query(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
    if (!query.value) {
      const DWORD error = GetLastError();
      if (error == ERROR_INVALID_PARAMETER) continue;
      report("query-open-failed", pid, error);
      return 2;
    }
    if (exited(query.value)) continue;
    std::wstring path;
    DWORD error = 0;
    if (!imagePath(query.value, path, error)) {
      if (exited(query.value)) continue;
      report("query-failed", pid, error);
      return 2;
    }
    if (!samePath(path, expected)) continue;
    if (!terminate) {
      report("rescan-failed", pid);
      return 2;
    }
    Handle target(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE,
                              FALSE, pid));
    if (!target.value) {
      error = GetLastError();
      if (exited(query.value)) continue;
      report("terminate-open-failed", pid, error);
      return 2;
    }
    if (WaitForSingleObject(target.value, 0) == WAIT_OBJECT_0) continue;
    // 查询句柄保持旧进程对象存活；创建时间和路径都必须与终止句柄核对。
    if (!sameProcess(query.value, target.value, error)) {
      if (exited(query.value)) continue;
      report("target-identity-failed", pid, error);
      return 2;
    }
    if (!imagePath(target.value, path, error)) {
      if (WaitForSingleObject(target.value, 0) == WAIT_OBJECT_0) continue;
      report("target-query-failed", pid, error);
      return 2;
    }
    if (!samePath(path, expected)) continue;
    report("matched", pid);
    if (!TerminateProcess(target.value, 0)) {
      error = GetLastError();
      if (WaitForSingleObject(target.value, 0) != WAIT_OBJECT_0) {
        report("terminate-failed", pid, error);
        return 2;
      }
    }
    const DWORD wait = WaitForSingleObject(target.value, 5000);
    if (wait != WAIT_OBJECT_0) {
      report("wait-failed", pid, wait == WAIT_FAILED ? GetLastError() : wait);
      return 2;
    }
    report("exited", pid);
  } while (Process32NextW(snapshot.value, &entry));
  const DWORD error = GetLastError();
  if (error != ERROR_NO_MORE_FILES) {
    report("enumerate-failed", 0, error);
    return 2;
  }
  return 0;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) {
    report("arguments-failed", 0);
    return 2;
  }
  std::vector<wchar_t> buffer(32768);
  DWORD length = GetFullPathNameW(argv[1], static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
  if (length == 0 || length >= buffer.size()) {
    report("path-failed", 0, GetLastError());
    return 2;
  }
  const std::wstring expected(buffer.data(), length);
  if (scan(expected, true) != 0 || scan(expected, false) != 0) return 2;
  report("stop-completed", 0);
  return 0;
}
