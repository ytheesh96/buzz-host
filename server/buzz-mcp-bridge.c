// buzz-mcp-bridge: the agent's Buzz tools, forwarded in a few hundred KB of C.
//
//   buzz-mcp-bridge <agent-pubkey> [--attention] [--computer] [--orchestrate]
//
// One per agent session (started by the wrapper buzz-host writes): it forwards
// stdio MCP JSON-RPC to buzz-host's single MCP session server on
// $XDG_RUNTIME_DIR/buzz-host/mcp.sock, opening with the _buzzMcpInit line that
// names the agent, its tool groups, chat key and cwd. buzz-host owns memory,
// Attention and orchestrator state, so a session is a few hundred KB here
// instead of a whole Node/V8 process. stdin EOF exits 0; if buzz-host restarts
// the bridge reconnects and re-sends the handshake before replaying what it had
// not written yet, so a session keeps its tools across a host restart.
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#define MAX_PENDING ((size_t)4 << 20) /* buffered stdin, one MCP line cap */
#define CHUNK 65536
#define RECONNECT_MS 250
#define STARTUP_TRIES 20
#define USAGE \
  "buzz-mcp-bridge: usage: buzz-mcp-bridge <agent-pubkey> [--attention] [--computer] [--orchestrate]\n"
typedef struct {
  char *data;
  size_t off, len, cap;
} buffer;
static buffer pending; /* stdin -> socket */
static buffer out;     /* socket -> stdout */
static int sock = -1;
static const char *init_line;
static size_t init_len;
static void die(const char *what) {
  fprintf(stderr, "buzz-mcp-bridge: %s\n", what);
  exit(1);
}
static size_t avail(const buffer *b) { return b->len - b->off; }
static void reset(buffer *b) { b->off = b->len = 0; }
static int push(buffer *b, const void *data, size_t n) {
  if (!n) return 0;
  if (b->len + n > b->cap) {
    size_t cap = b->cap ? b->cap : 4096;
    while (cap < b->len + n) cap *= 2;
    char *p = realloc(b->data, cap);
    if (!p) return -1;
    b->data = p;
    b->cap = cap;
  }
  memcpy(b->data + b->len, data, n);
  b->len += n;
  return 0;
}
static int push_str(buffer *b, const char *s) { return push(b, s, strlen(s)); }
/* Write what the fd takes. 1 = all sent, 0 = would block, -1 = fatal. */
static int flush(buffer *b, int fd) {
  while (b->off < b->len) {
    ssize_t n = write(fd, b->data + b->off, b->len - b->off);
    if (n > 0) b->off += (size_t)n;
    else if (n < 0 && errno == EINTR) continue;
    else if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return 0;
    else return -1;
  }
  reset(b);
  return 1;
}
/* JSON string literal: quotes, backslashes and control characters escaped. */
static int json_string(buffer *b, const char *s) {
  static const char *hex = "0123456789abcdef";
  static const char named[] = "\"\\\n\r\t\b\f";
  static const char *escaped[] = {"\\\"", "\\\\", "\\n", "\\r", "\\t", "\\b", "\\f"};
  char esc[7] = "\\u0000";
  if (push_str(b, "\"")) return -1;
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    const char *hit = *p >= 0x20 ? strchr(named, (int)*p) : NULL;
    if (hit) {
      if (push_str(b, escaped[hit - named])) return -1;
    } else if (*p >= 0x20) {
      if (push(b, p, 1)) return -1;
    } else {
      esc[4] = hex[*p >> 4];
      esc[5] = hex[*p & 0xf];
      if (push(b, esc, 6)) return -1;
    }
  }
  return push_str(b, "\"");
}
static int is_hex64(const char *s) {
  size_t i;
  if (!s || strlen(s) != 64) return 0;
  for (i = 0; i < 64; i++)
    if (!strchr("0123456789abcdef", s[i]) || s[i] == '\0') return 0;
  return 1;
}
static int connect_once(const struct sockaddr_un *addr) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  if (connect(fd, (const struct sockaddr *)addr, sizeof *addr) != 0) {
    close(fd);
    return -1;
  }
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags >= 0) fcntl(fd, F_SETFL, flags | O_NONBLOCK);
  return fd;
}
/* The socket died: drop bytes already handed to it (they may be a partial
 * line), keep bytes never written so they can follow the next handshake. */
static void drop_socket(void) {
  if (sock >= 0) close(sock);
  sock = -1;
  if (pending.off > 0) reset(&pending);
}
static void queue_init(void) {
  size_t live = avail(&pending);
  if (init_len + live > MAX_PENDING) { // too much unsent traffic: the handshake wins
    reset(&pending);
    live = 0;
  }
  char *p = malloc(init_len + live);
  if (!p) die("out of memory");
  memcpy(p, init_line, init_len);
  if (live) memcpy(p + init_len, pending.data + pending.off, live);
  free(pending.data);
  pending.data = p;
  pending.off = 0;
  pending.len = pending.cap = init_len + live;
}
int main(int argc, char **argv) {
  const char *pubkey = NULL;
  int attention = 0, computer = 0, orchestrate = 0, i;
  for (i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--attention")) attention = 1;
    else if (!strcmp(argv[i], "--computer")) computer = 1;
    else if (!strcmp(argv[i], "--orchestrate")) orchestrate = 1;
    else if (argv[i][0] == '-' || pubkey) {
      fputs(USAGE, stderr);
      return 2;
    } else pubkey = argv[i];
  }
  if (!pubkey) pubkey = getenv("BUZZHOST_AGENT");
  if (!is_hex64(pubkey)) {
    fputs(USAGE, stderr);
    return 2;
  }
  // Worker Solo chats set BUZZHOST_NO_ORCHESTRATE=1 via acp-proxy so even an
  // orchestrator delegating to itself has zero orch_* tools (MAX_DEPTH = 1).
  const char *no_orch = getenv("BUZZHOST_NO_ORCHESTRATE");
  if (orchestrate && no_orch && !strcmp(no_orch, "1")) orchestrate = 0;
  signal(SIGPIPE, SIG_IGN);
  char cwd[4096];
  if (!getcwd(cwd, sizeof cwd)) snprintf(cwd, sizeof cwd, ".");
  const char *chat = getenv("BUZZHOST_CHAT");
  const char *runtime = getenv("XDG_RUNTIME_DIR");
  char fallback[64];
  if (!runtime || !*runtime) {
    snprintf(fallback, sizeof fallback, "/run/user/%u", (unsigned)geteuid());
    runtime = fallback;
  }
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  int n = snprintf(addr.sun_path, sizeof addr.sun_path, "%s/buzz-host/mcp.sock", runtime);
  if (n < 0 || (size_t)n >= sizeof addr.sun_path) die("socket path is too long");
  buffer init = {0};
  char flags[96];
  snprintf(flags, sizeof flags, "\",\"attention\":%s,\"computer\":%s,\"orchestrate\":%s",
           attention ? "true" : "false", computer ? "true" : "false", orchestrate ? "true" : "false");
  if (push_str(&init, "{\"_buzzMcpInit\":true,\"pubkey\":\"") || push(&init, pubkey, 64) ||
      push_str(&init, flags) || push_str(&init, ",\"chat\":") || json_string(&init, chat ? chat : "") ||
      push_str(&init, ",\"cwd\":") || json_string(&init, cwd) || push_str(&init, "}\n"))
    die("out of memory");
  init_line = init.data;
  init_len = init.len;
  for (i = 0; i < STARTUP_TRIES && sock < 0; i++) {
    sock = connect_once(&addr);
    if (sock < 0) {
      struct timespec ts = {0, 50 * 1000000L};
      nanosleep(&ts, NULL);
    }
  }
  if (sock < 0) die("buzz-host is not running on this host (no mcp.sock)");
  queue_init();
  if (flush(&pending, sock) < 0) drop_socket();
  for (;;) {
    // buzz-host restarted: keep trying so the next request lands on the new one.
    if (sock < 0 && (sock = connect_once(&addr)) >= 0) {
      queue_init();
      if (flush(&pending, sock) < 0) drop_socket();
    }
    struct pollfd fds[3];
    nfds_t nfds = 0;
    int in = -1, sk = -1, op = -1;
    if (avail(&pending) < MAX_PENDING) {
      in = (int)nfds;
      fds[nfds++] = (struct pollfd){.fd = 0, .events = POLLIN};
    }
    if (sock >= 0) {
      sk = (int)nfds;
      fds[nfds++] = (struct pollfd){
        .fd = sock,
        .events = (short)((avail(&out) ? 0 : POLLIN) | (avail(&pending) ? POLLOUT : 0)),
      };
    }
    if (avail(&out)) {
      op = (int)nfds;
      fds[nfds++] = (struct pollfd){.fd = 1, .events = POLLOUT};
    }
    int r = poll(fds, nfds, sock >= 0 ? -1 : RECONNECT_MS);
    if (r < 0) {
      if (errno == EINTR) continue;
      die("poll failed");
    }
    if (op >= 0 && fds[op].revents && flush(&out, 1) < 0) return 0; // runtime closed stdout
    if (sk >= 0) {
      short rev = fds[sk].revents;
      if ((rev & POLLOUT) && flush(&pending, sock) < 0) drop_socket();
      if (sock >= 0 && (rev & POLLIN)) {
        char chunk[CHUNK];
        ssize_t got = read(sock, chunk, sizeof chunk);
        if (got > 0) {
          if (push(&out, chunk, (size_t)got)) die("out of memory");
          if (flush(&out, 1) < 0) return 0;
        } else if (got == 0) {
          drop_socket(); // buzz-host stopped; reconnect before the next line
        } else if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) {
          drop_socket();
        }
      }
      if (sock >= 0 && (rev & (POLLERR | POLLHUP | POLLNVAL))) drop_socket();
    }
    if (in >= 0 && fds[in].revents) {
      char chunk[CHUNK];
      ssize_t got = read(0, chunk, sizeof chunk);
      if (got == 0) return 0; // stdin EOF: this session is over
      if (got > 0) {
        if (push(&pending, chunk, (size_t)got)) die("out of memory");
        if (sock >= 0 && flush(&pending, sock) < 0) drop_socket();
      } else if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) {
        return 0;
      }
    }
  }
}
