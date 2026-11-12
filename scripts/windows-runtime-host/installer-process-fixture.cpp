#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <cstdio>
#include <cwchar>

namespace {
DWORD WINAPI commands(void*) {
  char command;
  DWORD read = 0;
  while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), &command, 1, &read, nullptr) && read != 0) {
    if (command == 'q') return 0;
    if (command == 'p') {
      std::printf("alive pid=%lu\n", GetCurrentProcessId());
      std::fflush(stdout);
    }
  }
  return 0;
}

DWORD openError(DWORD access) {
  HANDLE process = OpenProcess(access, FALSE, GetCurrentProcessId());
  if (!process) return GetLastError();
  CloseHandle(process);
  return ERROR_SUCCESS;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc < 2) return 2;
  const bool restricted = wcscmp(argv[1], L"--restricted") == 0;
  const bool denyQuery = wcscmp(argv[1], L"--deny-query") == 0;
  const bool normal = wcscmp(argv[1], L"--normal") == 0;
  const bool readonlyLog = wcscmp(argv[1], L"--log-readonly") == 0;
  const bool exclusiveLog = wcscmp(argv[1], L"--log-exclusive") == 0;
  const bool appendFailure = wcscmp(argv[1], L"--log-append-failure") == 0;
  const bool logMode = readonlyLog || exclusiveLog || appendFailure;
  if ((!restricted && !denyQuery && !normal && !logMode) || argc != (logMode ? 3 : 2)) return 2;

  if (restricted || denyQuery) {
    alignas(DWORD) BYTE sidStorage[SECURITY_MAX_SID_SIZE];
    DWORD sidLength = sizeof(sidStorage);
    if (!CreateWellKnownSid(WinWorldSid, nullptr, sidStorage, &sidLength)) return 3;
    alignas(ACL) BYTE aclStorage[1024];
    auto acl = reinterpret_cast<PACL>(aclStorage);
    const DWORD queryRights = PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_QUERY_INFORMATION;
    if (!InitializeAcl(acl, sizeof(aclStorage), ACL_REVISION) ||
        !AddAccessDeniedAce(acl, ACL_REVISION, PROCESS_TERMINATE | (denyQuery ? queryRights : 0), sidStorage) ||
        !AddAccessAllowedAce(acl, ACL_REVISION, SYNCHRONIZE | (denyQuery ? 0 : queryRights), sidStorage) ||
        SetSecurityInfo(GetCurrentProcess(), SE_KERNEL_OBJECT, DACL_SECURITY_INFORMATION,
                        nullptr, nullptr, acl, nullptr) != ERROR_SUCCESS) return 4;
  }

  HANDLE log = INVALID_HANDLE_VALUE;
  DWORD originalAttributes = INVALID_FILE_ATTRIBUTES;
  OVERLAPPED range{};
  DWORD logOpenError = 0;
  DWORD logWriteError = 0;
  if (logMode) {
    if (readonlyLog) {
      originalAttributes = GetFileAttributesW(argv[2]);
      if (originalAttributes == INVALID_FILE_ATTRIBUTES ||
          !SetFileAttributesW(argv[2], originalAttributes | FILE_ATTRIBUTE_READONLY)) return 5;
    } else {
      log = CreateFileW(argv[2], GENERIC_READ | GENERIC_WRITE,
                        exclusiveLog ? 0 : FILE_SHARE_READ | FILE_SHARE_WRITE,
                        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
      if (log == INVALID_HANDLE_VALUE) return 6;
      // 共享打开仍然成功，但字节范围锁令真正的追加写入返回 ERROR_LOCK_VIOLATION。
      if (appendFailure && !LockFileEx(log, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                                      0, MAXDWORD, MAXDWORD, &range)) {
        CloseHandle(log);
        return 7;
      }
    }
    HANDLE probe = CreateFileW(argv[2], FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
                               nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (probe == INVALID_HANDLE_VALUE) {
      logOpenError = GetLastError();
    } else {
      DWORD written = 0;
      if (!WriteFile(probe, "probe", 5, &written, nullptr)) logWriteError = GetLastError();
      CloseHandle(probe);
    }
  }

  // 修复原因：固定睡眠让拒绝终止权限的回归每次耗时 12 秒；stdin 关闭即退出，超时只防泄漏。
  HANDLE reader = CreateThread(nullptr, 0, commands, nullptr, 0, nullptr);
  if (reader) {
    std::printf("ready pid=%lu terminate-open-error=%lu query-open-error=%lu log-open-error=%lu log-write-error=%lu\n",
                GetCurrentProcessId(), openError(PROCESS_TERMINATE),
                openError(PROCESS_QUERY_LIMITED_INFORMATION), logOpenError, logWriteError);
    std::fflush(stdout);
    WaitForSingleObject(reader, 12000);
    CloseHandle(reader);
  }
  if (appendFailure && log != INVALID_HANDLE_VALUE) UnlockFileEx(log, 0, MAXDWORD, MAXDWORD, &range);
  if (log != INVALID_HANDLE_VALUE) CloseHandle(log);
  if (originalAttributes != INVALID_FILE_ATTRIBUTES && !SetFileAttributesW(argv[2], originalAttributes)) return 8;
  return reader ? 0 : 9;
}
