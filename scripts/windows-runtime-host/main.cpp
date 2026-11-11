#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>
#include <cwchar>
#include <string>
#include <vector>

namespace {
constexpr ULONGLONG kGraceMs = 1800;
struct Handle {
  HANDLE value = nullptr;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
bool send(HANDLE pipe, const std::string& message) {
  const auto frame = message + "\n";
  DWORD count;
  return WriteFile(pipe, frame.data(), static_cast<DWORD>(frame.size()), &count, nullptr) && count == frame.size();
}
std::wstring quote(const std::wstring& arg) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (const auto c : arg) {
    if (c == L'\\') { ++slashes; continue; }
    result.append(slashes * (c == L'"' ? 2 : 1), L'\\');
    slashes = 0;
    if (c == L'"') result += L'\\';
    result += c;
  }
  result.append(slashes * 2, L'\\');
  return result + L'"';
}
int fail(const char* stage) {
  std::fprintf(stderr, "[windows-runtime-host] %s failed (%lu)\n", stage, GetLastError());
  return 1;
}
}

int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wstring(argv[1]) == L"--version") {
    std::puts("zcode-runtime-host 1"); return 0;
  }
  if (argc == 3 && std::wstring(argv[1]) == L"--check-empty") {
    Handle previous{OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, argv[2])};
    // 内核在最后一个句柄关闭且全部成员退出后销毁 Job；不存在是原 Job 已消失的事实。
    if (!previous.value) return GetLastError() == ERROR_FILE_NOT_FOUND ? 0 : fail("open previous Job");
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    if (!QueryInformationJobObject(previous.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) return fail("previous Job membership");
    return accounting.ActiveProcesses == 0 ? 0 : 2;
  }
  if (argc < 5) return fail("arguments");
  const DWORD parentPid = wcstoul(argv[2], nullptr, 10);
  Handle parent{OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parentPid)};
  if (!parent.value) return fail("parent handle");
  Handle control{CreateFileW(argv[1], GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr)};
  if (control.value == INVALID_HANDLE_VALUE) return fail("control pipe");
  ULONG serverPid = 0;
  if (!GetNamedPipeServerProcessId(control.value, &serverPid) || serverPid != parentPid ||
      WaitForSingleObject(parent.value, 0) != WAIT_TIMEOUT) return fail("control owner");

  Handle job{CreateJobObjectW(nullptr, argv[3])};
  if (!job.value || GetLastError() == ERROR_ALREADY_EXISTS) return fail("create unique Job");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return fail("configure Job");

  // 原因：spawn 后再 attach 有派生窗口，退出后按 PPID 补查又可能误认复用的 PID。
  // 只传递三条 stdio，并通过创建属性加入 Job，避免 helper 在 create/assign 之间崩溃。
  // CLI 在 Host 接管前始终保持 suspended；不支持 Job 属性时明确拒绝启动。
  Handle input, output, error;
  HANDLE inherited[3];
  Handle* copies[] = {&input, &output, &error};
  const DWORD ids[] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  for (int i = 0; i < 3; ++i) {
    if (!DuplicateHandle(GetCurrentProcess(), GetStdHandle(ids[i]), GetCurrentProcess(),
                         &copies[i]->value, 0, TRUE, DUPLICATE_SAME_ACCESS)) return fail("stdio handles");
    inherited[i] = copies[i]->value;
  }
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
  std::vector<unsigned char> storage(size);
  auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 2, 0, &size)) return fail("handle list");
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                  inherited, sizeof(inherited), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attributes); return fail("inherit list");
  }
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                  &job.value, sizeof(job.value), nullptr, nullptr)) {
    DeleteProcThreadAttributeList(attributes); return fail("creation Job attribute");
  }
  STARTUPINFOEXW si{};
  si.StartupInfo.cb = sizeof(si);
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = input.value;
  si.StartupInfo.hStdOutput = output.value;
  si.StartupInfo.hStdError = error.value;
  si.lpAttributeList = attributes;
  std::wstring command;
  for (int i = 4; i < argc; ++i) {
    if (i > 4) command += L' ';
    command += quote(argv[i]);
  }
  PROCESS_INFORMATION pi{};
  const BOOL created = CreateProcessW(nullptr, command.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
      nullptr, nullptr, &si.StartupInfo, &pi);
  const DWORD createError = GetLastError();
  DeleteProcThreadAttributeList(attributes);
  if (!created) { SetLastError(createError); return fail("create suspended CLI"); }
  Handle root{pi.hProcess}, primaryThread{pi.hThread};
  BOOL assigned = FALSE;
  if (!IsProcessInJob(root.value, job.value, &assigned) || !assigned) {
    TerminateProcess(root.value, 1);
    return fail("verify creation Job ownership");
  }
  bool start = false, close = false, lost = false;
  std::string controlLine;
  bool running = false, rootExited = false, forced = false;
  ULONGLONG closeAt = 0;
  const auto startupDeadline = GetTickCount64() + 10000;
  if (!send(control.value, "ready " + std::to_string(pi.dwProcessId))) lost = true;
  int result = 0;
  for (;;) {
    DWORD available = 0;
    if (!lost && !PeekNamedPipe(control.value, nullptr, 0, nullptr, &available, nullptr)) lost = true;
    while (!lost && available-- > 0) {
      char c; DWORD count;
      if (!ReadFile(control.value, &c, 1, &count, nullptr) || count != 1) { lost = true; break; }
      if (c == '\n') {
        if (controlLine == "start") start = true;
        else if (controlLine == "close") close = true;
        else lost = true;
        controlLine.clear();
      } else if (controlLine.size() < 32) controlLine += c;
      else lost = true;
    }
    const auto now = GetTickCount64();
    const bool abandoned = lost || WaitForSingleObject(parent.value, 0) == WAIT_OBJECT_0;
    if (!running && start && !close && !abandoned) {
      if (ResumeThread(primaryThread.value) == static_cast<DWORD>(-1)) { result = fail("resume CLI"); break; }
      running = true;
      if (!send(control.value, "started")) lost = true;
    }
    if (!rootExited && WaitForSingleObject(root.value, 0) == WAIT_OBJECT_0) {
      rootExited = true;
      DWORD code;
      if (!GetExitCodeProcess(root.value, &code)) { result = fail("root exit status"); break; }
      if (!lost && !send(control.value, "root " + std::to_string(code))) lost = true;
    }
    if (close && closeAt == 0) closeAt = now;
    // 根退出表示它已完成自身收尾；残余成员仍归 Job，不能因根 PID 消失释放所有权。
    const bool mustTerminate = abandoned || rootExited || (!running && (close || now >= startupDeadline)) ||
                              (closeAt != 0 && now - closeAt >= kGraceMs);
    if (mustTerminate && !forced) {
      if (!TerminateJobObject(job.value, 1)) { result = fail("terminate Job"); break; }
      forced = true;
    }
    if (rootExited) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr)) {
        result = fail("query Job membership"); break;
      }
      if (accounting.ActiveProcesses == 0 && rootExited) {
        if (!lost) send(control.value, "empty");
        break;
      }
    }
    // 等待句柄事件；短轮询只复核内核 Job 计数，不枚举系统进程，也不把超时当清空。
    HANDLE waits[] = {parent.value, root.value};
    if (abandoned) Sleep(50);
    else WaitForMultipleObjects(rootExited ? 1 : 2, waits, FALSE, 50);
  }
  // 异常退出仍由最后一个 Job 句柄负责强制回收。
  return result;
}
