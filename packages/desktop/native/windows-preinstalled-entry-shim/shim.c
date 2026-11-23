/*
 * 预装工具的 Windows 入口 shim。规格见 docs/preinstalled-tools/windows-entry-shim.md。
 *
 * 读取与自身同名的 .shim 配置（UTF-8 JSON），按配置设置环境，启动目标，等待目标结束，
 * 以目标的退出码退出。调用方参数取 GetCommandLineW 中第一个参数之后的原文，原样追加。
 * 只依赖 Windows API 与 C 运行库，全程使用宽字符，不受系统代码页影响。
 */
#include <windows.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define SHIM_FAILURE 127

enum env_action { ENV_SET, ENV_DEFAULT, ENV_UNSET };

typedef struct {
  wchar_t *name;
  wchar_t *value;
  enum env_action action;
} env_op;

typedef struct {
  wchar_t *target;
  wchar_t **args;
  size_t arg_count;
  env_op *env;
  size_t env_count;
} shim_config;

typedef struct {
  wchar_t *data;
  size_t length;
  size_t capacity;
} wide_buffer;

typedef struct {
  const unsigned char *at;
  const unsigned char *end;
} json_reader;

static void write_error(const wchar_t *text) {
  HANDLE handle = GetStdHandle(STD_ERROR_HANDLE);
  DWORD mode;
  DWORD written;
  int bytes;
  char *utf8;
  if (handle == NULL || handle == INVALID_HANDLE_VALUE) return;
  if (GetConsoleMode(handle, &mode)) {
    WriteConsoleW(handle, text, (DWORD)wcslen(text), &written, NULL);
    return;
  }
  bytes = WideCharToMultiByte(CP_UTF8, 0, text, -1, NULL, 0, NULL, NULL);
  if (bytes <= 1) return;
  utf8 = (char *)malloc((size_t)bytes);
  if (utf8 == NULL) return;
  WideCharToMultiByte(CP_UTF8, 0, text, -1, utf8, bytes, NULL, NULL);
  WriteFile(handle, utf8, (DWORD)(bytes - 1), &written, NULL);
  free(utf8);
}

/* 配置缺失、格式不对或目标无法启动时，写一行原因，以固定退出码 127 退出。 */
static __declspec(noreturn) void fail(const wchar_t *format, ...) {
  wchar_t message[2048];
  va_list arguments;
  int prefix = _snwprintf_s(message, _countof(message), _TRUNCATE,
                            L"zcode-preinstalled-entry-shim: ");
  va_start(arguments, format);
  _vsnwprintf_s(message + prefix, _countof(message) - (size_t)prefix, _TRUNCATE, format,
                arguments);
  va_end(arguments);
  wcsncat_s(message, _countof(message), L"\r\n", _TRUNCATE);
  write_error(message);
  ExitProcess(SHIM_FAILURE);
}

static void *checked_alloc(size_t size) {
  void *memory = calloc(1, size == 0 ? 1 : size);
  if (memory == NULL) fail(L"out of memory");
  return memory;
}

static void buffer_reserve(wide_buffer *buffer, size_t extra) {
  size_t needed = buffer->length + extra + 1;
  wchar_t *grown;
  if (needed <= buffer->capacity) return;
  buffer->capacity = needed * 2;
  grown = (wchar_t *)realloc(buffer->data, buffer->capacity * sizeof(wchar_t));
  if (grown == NULL) fail(L"out of memory");
  buffer->data = grown;
}

static void buffer_append_n(wide_buffer *buffer, const wchar_t *text, size_t count) {
  buffer_reserve(buffer, count);
  memcpy(buffer->data + buffer->length, text, count * sizeof(wchar_t));
  buffer->length += count;
  buffer->data[buffer->length] = L'\0';
}

static void buffer_append_char(wide_buffer *buffer, wchar_t value, size_t repeat) {
  buffer_reserve(buffer, repeat);
  while (repeat-- > 0) buffer->data[buffer->length++] = value;
  buffer->data[buffer->length] = L'\0';
}

/* 按 CommandLineToArgvW 的规则加引号：引号前的反斜杠加倍，引号本身转义。 */
static void append_quoted_argument(wide_buffer *buffer, const wchar_t *argument) {
  const wchar_t *cursor;
  if (argument[0] != L'\0' && wcspbrk(argument, L" \t\n\v\"") == NULL) {
    buffer_append_n(buffer, argument, wcslen(argument));
    return;
  }
  buffer_append_char(buffer, L'"', 1);
  for (cursor = argument;; ++cursor) {
    size_t backslashes = 0;
    while (*cursor == L'\\') {
      ++cursor;
      ++backslashes;
    }
    if (*cursor == L'\0') {
      buffer_append_char(buffer, L'\\', backslashes * 2);
      break;
    }
    if (*cursor == L'"') {
      buffer_append_char(buffer, L'\\', backslashes * 2 + 1);
    } else {
      buffer_append_char(buffer, L'\\', backslashes);
    }
    buffer_append_char(buffer, *cursor, 1);
  }
  buffer_append_char(buffer, L'"', 1);
}

/* 跳过 GetCommandLineW 中的程序名，规则与 C 运行库解析 argv[0] 相同。 */
static const wchar_t *caller_arguments(void) {
  const wchar_t *cursor = GetCommandLineW();
  if (*cursor == L'"') {
    ++cursor;
    while (*cursor != L'\0' && *cursor != L'"') ++cursor;
    if (*cursor == L'"') ++cursor;
  } else {
    while (*cursor != L'\0' && *cursor != L' ' && *cursor != L'\t') ++cursor;
  }
  while (*cursor == L' ' || *cursor == L'\t') ++cursor;
  return cursor;
}

static wchar_t *config_path(void) {
  DWORD capacity = MAX_PATH;
  wchar_t *path;
  wchar_t *separator;
  wchar_t *extension;
  size_t stem;
  wchar_t *result;
  for (;;) {
    DWORD length;
    path = (wchar_t *)checked_alloc(capacity * sizeof(wchar_t));
    length = GetModuleFileNameW(NULL, path, capacity);
    if (length == 0) fail(L"cannot read own path (error %lu)", GetLastError());
    if (length < capacity) break;
    free(path);
    capacity *= 2;
  }
  separator = wcsrchr(path, L'\\');
  extension = wcsrchr(path, L'.');
  stem = (extension != NULL && (separator == NULL || extension > separator))
             ? (size_t)(extension - path)
             : wcslen(path);
  result = (wchar_t *)checked_alloc((stem + 6) * sizeof(wchar_t));
  memcpy(result, path, stem * sizeof(wchar_t));
  wcscpy_s(result + stem, 6, L".shim");
  free(path);
  return result;
}

static unsigned char *read_file(const wchar_t *path, size_t *size) {
  HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, NULL,
                            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  LARGE_INTEGER length;
  unsigned char *data;
  DWORD read;
  if (file == INVALID_HANDLE_VALUE)
    fail(L"cannot open config %ls (error %lu)", path, GetLastError());
  if (!GetFileSizeEx(file, &length) || length.QuadPart > 16 * 1024 * 1024)
    fail(L"invalid config size: %ls", path);
  data = (unsigned char *)checked_alloc((size_t)length.QuadPart + 1);
  if (!ReadFile(file, data, (DWORD)length.QuadPart, &read, NULL) ||
      read != (DWORD)length.QuadPart)
    fail(L"cannot read config %ls (error %lu)", path, GetLastError());
  CloseHandle(file);
  *size = (size_t)length.QuadPart;
  return data;
}

static void json_skip_space(json_reader *reader) {
  while (reader->at < reader->end &&
         (*reader->at == ' ' || *reader->at == '\t' || *reader->at == '\r' || *reader->at == '\n'))
    ++reader->at;
}

static void json_expect(json_reader *reader, unsigned char value) {
  json_skip_space(reader);
  if (reader->at >= reader->end || *reader->at != value) fail(L"invalid config: expected '%c'", value);
  ++reader->at;
}

static int json_peek(json_reader *reader, unsigned char value) {
  json_skip_space(reader);
  return reader->at < reader->end && *reader->at == value;
}

static unsigned int json_hex4(json_reader *reader) {
  unsigned int value = 0;
  int index;
  if (reader->end - reader->at < 4) fail(L"invalid config: short \\u escape");
  for (index = 0; index < 4; ++index) {
    unsigned char digit = *reader->at++;
    value <<= 4;
    if (digit >= '0' && digit <= '9') value |= (unsigned int)(digit - '0');
    else if (digit >= 'a' && digit <= 'f') value |= (unsigned int)(digit - 'a' + 10);
    else if (digit >= 'A' && digit <= 'F') value |= (unsigned int)(digit - 'A' + 10);
    else fail(L"invalid config: bad \\u escape");
  }
  return value;
}

/* 先把字符串解码成 UTF-8 字节，再严格转换为宽字符；非法 UTF-8 直接拒绝。 */
static wchar_t *json_string(json_reader *reader) {
  unsigned char *bytes;
  size_t length = 0;
  int count;
  wchar_t *result;
  json_expect(reader, '"');
  bytes = (unsigned char *)checked_alloc((size_t)(reader->end - reader->at) + 1);
  for (;;) {
    unsigned char value;
    if (reader->at >= reader->end) fail(L"invalid config: unterminated string");
    value = *reader->at++;
    if (value == '"') break;
    if (value < 0x20) fail(L"invalid config: control character in string");
    if (value != '\\') {
      bytes[length++] = value;
      continue;
    }
    if (reader->at >= reader->end) fail(L"invalid config: unterminated escape");
    value = *reader->at++;
    switch (value) {
      case '"': bytes[length++] = '"'; break;
      case '\\': bytes[length++] = '\\'; break;
      case '/': bytes[length++] = '/'; break;
      case 'b': bytes[length++] = '\b'; break;
      case 'f': bytes[length++] = '\f'; break;
      case 'n': bytes[length++] = '\n'; break;
      case 'r': bytes[length++] = '\r'; break;
      case 't': bytes[length++] = '\t'; break;
      case 'u': {
        unsigned int code = json_hex4(reader);
        if (code >= 0xDC00 && code <= 0xDFFF) fail(L"invalid config: lone surrogate");
        if (code >= 0xD800 && code <= 0xDBFF) {
          unsigned int low;
          if (reader->end - reader->at < 2 || reader->at[0] != '\\' || reader->at[1] != 'u')
            fail(L"invalid config: lone surrogate");
          reader->at += 2;
          low = json_hex4(reader);
          if (low < 0xDC00 || low > 0xDFFF) fail(L"invalid config: lone surrogate");
          code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
        }
        if (code == 0) fail(L"invalid config: NUL in string");
        /* 转义后的 UTF-8 不会长于 \uXXXX 原文，缓冲区按输入长度分配即可。 */
        if (code < 0x80) {
          bytes[length++] = (unsigned char)code;
        } else if (code < 0x800) {
          bytes[length++] = (unsigned char)(0xC0 | (code >> 6));
          bytes[length++] = (unsigned char)(0x80 | (code & 0x3F));
        } else if (code < 0x10000) {
          bytes[length++] = (unsigned char)(0xE0 | (code >> 12));
          bytes[length++] = (unsigned char)(0x80 | ((code >> 6) & 0x3F));
          bytes[length++] = (unsigned char)(0x80 | (code & 0x3F));
        } else {
          bytes[length++] = (unsigned char)(0xF0 | (code >> 18));
          bytes[length++] = (unsigned char)(0x80 | ((code >> 12) & 0x3F));
          bytes[length++] = (unsigned char)(0x80 | ((code >> 6) & 0x3F));
          bytes[length++] = (unsigned char)(0x80 | (code & 0x3F));
        }
        break;
      }
      default: fail(L"invalid config: unknown escape");
    }
  }
  if (length == 0) {
    free(bytes);
    return (wchar_t *)checked_alloc(sizeof(wchar_t));
  }
  count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)bytes, (int)length,
                              NULL, 0);
  if (count <= 0) fail(L"invalid config: string is not UTF-8");
  result = (wchar_t *)checked_alloc(((size_t)count + 1) * sizeof(wchar_t));
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)bytes, (int)length, result,
                      count);
  free(bytes);
  return result;
}

static int json_integer(json_reader *reader) {
  int value = 0;
  json_skip_space(reader);
  if (reader->at >= reader->end || *reader->at < '0' || *reader->at > '9')
    fail(L"invalid config: expected integer");
  while (reader->at < reader->end && *reader->at >= '0' && *reader->at <= '9') {
    if (value > 100000) fail(L"invalid config: integer too large");
    value = value * 10 + (*reader->at++ - '0');
  }
  return value;
}

/* 逐项读取数组；回调读取一项。 */
static size_t json_array(json_reader *reader, void (*item)(json_reader *, void *), void *context) {
  size_t count = 0;
  json_expect(reader, '[');
  if (json_peek(reader, ']')) {
    ++reader->at;
    return 0;
  }
  for (;;) {
    item(reader, context);
    ++count;
    if (json_peek(reader, ',')) {
      ++reader->at;
      continue;
    }
    json_expect(reader, ']');
    return count;
  }
}

static void read_arg(json_reader *reader, void *context) {
  shim_config *config = (shim_config *)context;
  wchar_t **grown = (wchar_t **)realloc(config->args, (config->arg_count + 1) * sizeof(wchar_t *));
  if (grown == NULL) fail(L"out of memory");
  config->args = grown;
  config->args[config->arg_count++] = json_string(reader);
}

static void read_env(json_reader *reader, void *context) {
  shim_config *config = (shim_config *)context;
  env_op operation = {NULL, NULL, ENV_SET};
  wchar_t *action = NULL;
  env_op *grown;
  json_expect(reader, '{');
  for (;;) {
    wchar_t *key = json_string(reader);
    json_expect(reader, ':');
    if (wcscmp(key, L"name") == 0 && operation.name == NULL) operation.name = json_string(reader);
    else if (wcscmp(key, L"action") == 0 && action == NULL) action = json_string(reader);
    else if (wcscmp(key, L"value") == 0 && operation.value == NULL)
      operation.value = json_string(reader);
    else fail(L"invalid config: unexpected env field %ls", key);
    free(key);
    if (json_peek(reader, ',')) {
      ++reader->at;
      continue;
    }
    json_expect(reader, '}');
    break;
  }
  if (operation.name == NULL || operation.name[0] == L'\0' || wcschr(operation.name, L'=') != NULL)
    fail(L"invalid config: bad env name");
  if (action == NULL) fail(L"invalid config: env action missing");
  if (wcscmp(action, L"set") == 0) operation.action = ENV_SET;
  else if (wcscmp(action, L"default") == 0) operation.action = ENV_DEFAULT;
  else if (wcscmp(action, L"unset") == 0) operation.action = ENV_UNSET;
  else fail(L"invalid config: unknown env action %ls", action);
  if ((operation.action == ENV_UNSET) != (operation.value == NULL))
    fail(L"invalid config: env value does not match action for %ls", operation.name);
  free(action);
  grown = (env_op *)realloc(config->env, (config->env_count + 1) * sizeof(env_op));
  if (grown == NULL) fail(L"out of memory");
  config->env = grown;
  config->env[config->env_count++] = operation;
}

static void parse_config(const wchar_t *path, shim_config *config) {
  size_t size;
  unsigned char *data = read_file(path, &size);
  json_reader reader = {data, data + size};
  int version = -1;
  int have_args = 0;
  int have_env = 0;
  if (size >= 3 && data[0] == 0xEF && data[1] == 0xBB && data[2] == 0xBF) reader.at += 3;
  memset(config, 0, sizeof(*config));
  json_expect(&reader, '{');
  for (;;) {
    wchar_t *key = json_string(&reader);
    json_expect(&reader, ':');
    if (wcscmp(key, L"schemaVersion") == 0 && version < 0) version = json_integer(&reader);
    else if (wcscmp(key, L"target") == 0 && config->target == NULL)
      config->target = json_string(&reader);
    else if (wcscmp(key, L"args") == 0 && !have_args) {
      json_array(&reader, read_arg, config);
      have_args = 1;
    } else if (wcscmp(key, L"env") == 0 && !have_env) {
      json_array(&reader, read_env, config);
      have_env = 1;
    } else {
      fail(L"invalid config: unexpected field %ls", key);
    }
    free(key);
    if (json_peek(&reader, ',')) {
      ++reader.at;
      continue;
    }
    json_expect(&reader, '}');
    break;
  }
  json_skip_space(&reader);
  if (reader.at != reader.end) fail(L"invalid config: trailing data");
  if (version != 1) fail(L"unsupported config schemaVersion in %ls", path);
  if (config->target == NULL || !have_args || !have_env)
    fail(L"invalid config: target, args and env are required");
  free(data);
}

static void apply_environment(const shim_config *config) {
  size_t index;
  for (index = 0; index < config->env_count; ++index) {
    const env_op *operation = &config->env[index];
    BOOL ok = TRUE;
    if (operation->action == ENV_UNSET) {
      SetEnvironmentVariableW(operation->name, NULL);
      continue;
    }
    if (operation->action == ENV_DEFAULT) {
      /* 与 POSIX 入口的 ${NAME+x} 一致：变量存在（即使为空）就不覆盖。 */
      SetLastError(ERROR_SUCCESS);
      if (GetEnvironmentVariableW(operation->name, NULL, 0) != 0 ||
          GetLastError() != ERROR_ENVVAR_NOT_FOUND)
        continue;
    }
    ok = SetEnvironmentVariableW(operation->name, operation->value);
    if (!ok) fail(L"cannot set environment %ls (error %lu)", operation->name, GetLastError());
  }
}

/* 目标已经在同一控制台收到中断；shim 只需继续等待目标退出。 */
static BOOL WINAPI on_console_control(DWORD type) {
  return type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT;
}

int wmain(void) {
  shim_config config;
  wchar_t *path = config_path();
  wide_buffer command = {NULL, 0, 0};
  const wchar_t *rest = caller_arguments();
  size_t index;
  HANDLE job;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  STARTUPINFOEXW startup;
  SIZE_T attributes_size = 0;
  PROCESS_INFORMATION process;
  DWORD exit_code = SHIM_FAILURE;

  parse_config(path, &config);
  if (GetFileAttributesW(config.target) == INVALID_FILE_ATTRIBUTES)
    fail(L"target not found: %ls", config.target);
  apply_environment(&config);

  /* 目标路径不含引号，argv[0] 一律整体加引号。 */
  buffer_append_char(&command, L'"', 1);
  buffer_append_n(&command, config.target, wcslen(config.target));
  buffer_append_char(&command, L'"', 1);
  for (index = 0; index < config.arg_count; ++index) {
    buffer_append_char(&command, L' ', 1);
    append_quoted_argument(&command, config.args[index]);
  }
  if (*rest != L'\0') {
    buffer_append_char(&command, L' ', 1);
    buffer_append_n(&command, rest, wcslen(rest));
  }

  /* 调用方结束 shim 时作业关闭，目标及其后代一起结束；作业句柄不可继承。 */
  job = CreateJobObjectW(NULL, NULL);
  if (job == NULL) fail(L"cannot create job object (error %lu)", GetLastError());
  memset(&limits, 0, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
    fail(L"cannot configure job object (error %lu)", GetLastError());

  SetConsoleCtrlHandler(on_console_control, TRUE);

  memset(&startup, 0, sizeof(startup));
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  startup.StartupInfo.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  startup.StartupInfo.hStdError = GetStdHandle(STD_ERROR_HANDLE);
  /*
   * 目标在创建时直接入作业，它和它启动的子进程从一开始就在作业内。
   * 修复：原先挂起创建目标，再 AssignProcessToJobObject，再恢复运行。shim 在创建与入作业之间
   * 被结束时，目标停在挂起状态且不在作业内，没有进程会结束或恢复它，它一直占用版本目录。
   */
  InitializeProcThreadAttributeList(NULL, 1, 0, &attributes_size);
  startup.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)checked_alloc(attributes_size);
  if (!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &attributes_size) ||
      !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job,
                                 sizeof(job), NULL, NULL))
    fail(L"cannot attach job object to %ls (error %lu)", config.target, GetLastError());
  if (!CreateProcessW(NULL, command.data, NULL, NULL, TRUE,
                      EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, NULL, NULL,
                      &startup.StartupInfo, &process))
    fail(L"cannot start %ls (error %lu)", config.target, GetLastError());
  CloseHandle(process.hThread);
  WaitForSingleObject(process.hProcess, INFINITE);
  if (!GetExitCodeProcess(process.hProcess, &exit_code)) exit_code = SHIM_FAILURE;
  CloseHandle(process.hProcess);

  /* 目标正常结束：取消“作业关闭即结束”，保留它有意留在后台的后代进程。 */
  limits.BasicLimitInformation.LimitFlags = 0;
  SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits));
  CloseHandle(job);
  /* 直接用 ExitProcess，避免 C 运行库改写大于 INT_MAX 的退出码（例如 NTSTATUS）。 */
  ExitProcess(exit_code);
}
