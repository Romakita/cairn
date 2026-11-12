// Module natif de Cairn (N-API pur, ABI stable) : ce que Node ne sait pas faire sur macOS.
// Contrat côté TypeScript : desktop/src/core/native.ts. Un seul binaire sert Bun (tests) et Electron.
//
// - Trousseau : mots de passe génériques et Internet (SMB), lecture, ajout, mise à jour (fil de fond, Promise).
//   Jamais de suppression.
// - NetFS : montage SMB souple et sans interface (`NetFSMountURLSync` sur un fil de fond, Promise).
// - flock : exclusif non bloquant, exclusif bloquant (fil de fond, Promise), libération.
// - Espace libre « pour usage important » d'un volume (inclut le purgeable APFS).

#define NAPI_VERSION 8
#include <node_api.h>

#import <CoreFoundation/CoreFoundation.h>
#import <Foundation/Foundation.h>
#import <NetFS/NetFS.h>
#import <Security/Security.h>

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>

// MARK: - Outils N-API

#define CHECK(call)                                                                                                    \
  do {                                                                                                                 \
    if ((call) != napi_ok) return NULL;                                                                                \
  } while (0)

/** Lève une erreur JS `message` avec une propriété `code` numérique. */
static napi_value throw_code(napi_env env, const char *message, double code) {
  napi_value msg, err, num;
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &msg);
  napi_create_error(env, NULL, msg, &err);
  napi_create_double(env, code, &num);
  napi_set_named_property(env, err, "code", num);
  napi_throw(env, err);
  return NULL;
}

static napi_value make_error(napi_env env, const char *message, double code) {
  napi_value msg, err, num;
  napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &msg);
  napi_create_error(env, NULL, msg, &err);
  napi_create_double(env, code, &num);
  napi_set_named_property(env, err, "code", num);
  return err;
}

/** Chaîne UTF-8 allouée (à libérer avec free), ou NULL si la valeur n'est pas une chaîne. */
static char *copy_string(napi_env env, napi_value value) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return NULL;
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &len) != napi_ok) return NULL;
  char *buf = malloc(len + 1);
  if (!buf) return NULL;
  if (napi_get_value_string_utf8(env, value, buf, len + 1, &len) != napi_ok) {
    free(buf);
    return NULL;
  }
  return buf;
}

/** Propriété chaîne `name` de l'objet `obj`, en NSString ; NULL (et une TypeError levée) si absente. */
static NSString *string_property(napi_env env, napi_value obj, const char *name) {
  napi_value value;
  napi_valuetype type;
  if (napi_typeof(env, obj, &type) != napi_ok || type != napi_object) {
    napi_throw_type_error(env, NULL, "expected an object");
    return nil;
  }
  if (napi_get_named_property(env, obj, name, &value) != napi_ok) return nil;
  char *text = copy_string(env, value);
  if (!text) {
    char message[128];
    snprintf(message, sizeof message, "expected a string property \"%s\"", name);
    napi_throw_type_error(env, NULL, message);
    return nil;
  }
  NSString *out = [NSString stringWithUTF8String:text];
  free(text);
  return out;
}

static NSString *string_arg(napi_env env, napi_value value, const char *what) {
  char *text = copy_string(env, value);
  if (!text) {
    char message[128];
    snprintf(message, sizeof message, "expected a string for %s", what);
    napi_throw_type_error(env, NULL, message);
    return nil;
  }
  NSString *out = [NSString stringWithUTF8String:text];
  free(text);
  return out;
}

static int fd_arg(napi_env env, napi_value value, int *fd) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) {
    napi_throw_type_error(env, NULL, "expected a file descriptor");
    return 0;
  }
  int32_t n;
  napi_get_value_int32(env, value, &n);
  if (n < 0) {
    napi_throw_range_error(env, NULL, "invalid file descriptor");
    return 0;
  }
  *fd = n;
  return 1;
}

static napi_value js_null(napi_env env) {
  napi_value v;
  napi_get_null(env, &v);
  return v;
}

static napi_value js_undefined(napi_env env) {
  napi_value v;
  napi_get_undefined(env, &v);
  return v;
}

// MARK: - Trousseau
//
// Lecture et écriture sur un fil de fond (Promise) : `SecItemCopyMatching` peut attendre le déverrouillage du
// Trousseau ou une autorisation de l'utilisateur, et ne doit jamais bloquer la boucle d'événements d'Electron.

typedef enum { KEYCHAIN_GET, KEYCHAIN_SET } KeychainOp;

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  KeychainOp op;
  CFDictionaryRef query;  // retenu (CFBridgingRetain)
  CFDataRef password;     // KEYCHAIN_SET
  CFDictionaryRef extra;  // KEYCHAIN_SET : attributs ajoutés à la création
  OSStatus status;
  const char *failure;    // message d'erreur (chaîne statique)
  CFDataRef out;          // KEYCHAIN_GET : mot de passe lu
} KeychainJob;

static void keychain_execute(napi_env env, void *data) {
  (void)env;
  KeychainJob *job = data;
  @autoreleasepool {
    NSDictionary *query = (__bridge NSDictionary *)job->query;
    if (job->op == KEYCHAIN_GET) {
      NSMutableDictionary *q = [query mutableCopy];
      q[(__bridge id)kSecReturnData] = @YES;
      q[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
      CFTypeRef out = NULL;
      job->status = SecItemCopyMatching((__bridge CFDictionaryRef)q, &out);
      job->failure = "Keychain read failed";
      if (job->status == errSecSuccess && out && CFGetTypeID(out) == CFDataGetTypeID()) {
        job->out = (CFDataRef)out;
      } else if (out) {
        CFRelease(out);
      }
      return;
    }
    // Met à jour l'entrée, ou l'ajoute (avec `extra`) si elle n'existe pas. Ne supprime jamais rien.
    NSData *password = (__bridge NSData *)job->password;
    NSDictionary *update = @{(__bridge id)kSecValueData : password};
    job->status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)update);
    job->failure = "Keychain update failed";
    if (job->status == errSecItemNotFound) {
      NSMutableDictionary *add = [query mutableCopy];
      [add addEntriesFromDictionary:(__bridge NSDictionary *)job->extra];
      add[(__bridge id)kSecValueData] = password;
      job->status = SecItemAdd((__bridge CFDictionaryRef)add, NULL);
      job->failure = "Keychain add failed";
    }
  }
}

static void keychain_complete(napi_env env, napi_status napi_st, void *data) {
  KeychainJob *job = data;
  napi_value result;
  if (napi_st != napi_ok) {
    napi_reject_deferred(env, job->deferred, make_error(env, "Keychain operation cancelled", EINTR));
  } else if (job->op == KEYCHAIN_GET && job->status == errSecItemNotFound) {
    napi_resolve_deferred(env, job->deferred, js_null(env));
  } else if (job->status != errSecSuccess) {
    napi_reject_deferred(env, job->deferred, make_error(env, job->failure, job->status));
  } else if (job->op == KEYCHAIN_GET) {
    if (job->out) {
      napi_create_string_utf8(env, (const char *)CFDataGetBytePtr(job->out), (size_t)CFDataGetLength(job->out),
                              &result);
      napi_resolve_deferred(env, job->deferred, result);
    } else {
      napi_resolve_deferred(env, job->deferred, js_null(env));
    }
  } else {
    napi_resolve_deferred(env, job->deferred, js_undefined(env));
  }
  napi_delete_async_work(env, job->work);
  if (job->query) CFRelease(job->query);
  if (job->password) CFRelease(job->password);
  if (job->extra) CFRelease(job->extra);
  if (job->out) CFRelease(job->out);
  free(job);
}

/** Lance l'opération sur un fil de fond ; rend la Promise (mot de passe ou `null` pour une lecture). */
static napi_value keychain_queue(napi_env env, KeychainOp op, NSDictionary *query, NSString *password,
                                 NSDictionary *extra) {
  KeychainJob *job = calloc(1, sizeof *job);
  if (!job) return throw_code(env, "out of memory", ENOMEM);
  job->op = op;
  job->query = (CFDictionaryRef)CFBridgingRetain([query copy]);
  if (password) job->password = (CFDataRef)CFBridgingRetain([password dataUsingEncoding:NSUTF8StringEncoding]);
  if (extra) job->extra = (CFDictionaryRef)CFBridgingRetain([extra copy]);
  napi_value promise, name;
  napi_create_promise(env, &job->deferred, &promise);
  napi_create_string_utf8(env, op == KEYCHAIN_GET ? "cairn.keychainGet" : "cairn.keychainSet", NAPI_AUTO_LENGTH,
                          &name);
  napi_create_async_work(env, NULL, name, keychain_execute, keychain_complete, job, &job->work);
  napi_queue_async_work(env, job->work);
  return promise;
}

static NSMutableDictionary *generic_query(napi_env env, napi_value obj) {
  NSString *service = string_property(env, obj, "service");
  if (!service) return nil;
  NSString *account = string_property(env, obj, "account");
  if (!account) return nil;
  return [@{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : service,
    (__bridge id)kSecAttrAccount : account,
  } mutableCopy];
}

static NSMutableDictionary *internet_query(napi_env env, napi_value obj) {
  NSString *server = string_property(env, obj, "server");
  if (!server) return nil;
  NSString *account = string_property(env, obj, "account");
  if (!account) return nil;
  NSString *protocol = string_property(env, obj, "protocol");
  if (!protocol) return nil;
  if (![protocol isEqualToString:@"smb"]) {
    napi_throw_range_error(env, NULL, "unsupported keychain protocol");
    return nil;
  }
  return [@{
    (__bridge id)kSecClass : (__bridge id)kSecClassInternetPassword,
    (__bridge id)kSecAttrServer : server,
    (__bridge id)kSecAttrAccount : account,
    (__bridge id)kSecAttrProtocol : (__bridge id)kSecAttrProtocolSMB,
  } mutableCopy];
}

static napi_value KeychainGetGeneric(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t argc = 1;
    napi_value argv[1];
    CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    if (argc < 1) return throw_code(env, "missing query", EINVAL);
    NSMutableDictionary *query = generic_query(env, argv[0]);
    if (!query) return NULL;
    return keychain_queue(env, KEYCHAIN_GET, query, nil, nil);
  }
}

static napi_value KeychainSetGeneric(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t argc = 3;
    napi_value argv[3];
    CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    if (argc < 3) return throw_code(env, "expected query, password and label", EINVAL);
    NSMutableDictionary *query = generic_query(env, argv[0]);
    if (!query) return NULL;
    NSString *password = string_arg(env, argv[1], "password");
    if (!password) return NULL;
    NSString *label = string_arg(env, argv[2], "label");
    if (!label) return NULL;
    return keychain_queue(env, KEYCHAIN_SET, query, password, @{(__bridge id)kSecAttrLabel : label});
  }
}

static napi_value KeychainGetInternet(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t argc = 1;
    napi_value argv[1];
    CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    if (argc < 1) return throw_code(env, "missing query", EINVAL);
    NSMutableDictionary *query = internet_query(env, argv[0]);
    if (!query) return NULL;
    return keychain_queue(env, KEYCHAIN_GET, query, nil, nil);
  }
}

static napi_value KeychainSetInternet(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t argc = 2;
    napi_value argv[2];
    CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    if (argc < 2) return throw_code(env, "expected query and password", EINVAL);
    NSMutableDictionary *query = internet_query(env, argv[0]);
    if (!query) return NULL;
    NSString *password = string_arg(env, argv[1], "password");
    if (!password) return NULL;
    return keychain_queue(env, KEYCHAIN_SET, query, password, @{});
  }
}

// MARK: - NetFS

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  char *url;
  char *user;     // NULL : aucun utilisateur
  char *password; // NULL : pas de mot de passe (invité, Kerberos…)
  int status;
  char *mount_point;
} MountJob;

static void mount_execute(napi_env env, void *data) {
  (void)env;
  MountJob *job = data;
  @autoreleasepool {
    NSURL *url = [NSURL URLWithString:[NSString stringWithUTF8String:job->url]];
    if (!url) {
      job->status = EINVAL;
      return;
    }
    NSString *user = job->user ? [NSString stringWithUTF8String:job->user] : nil;
    NSString *password = job->password ? [NSString stringWithUTF8String:job->password] : nil;
    // Comme Providers.swift : aucune interface (pas de fenêtre d'authentification), montage souple.
    NSMutableDictionary *open = [@{(__bridge id)kNAUIOptionKey : (__bridge id)kNAUIOptionNoUI} mutableCopy];
    NSMutableDictionary *mount = [@{(__bridge id)kNetFSSoftMountKey : @YES} mutableCopy];
    CFArrayRef points = NULL;
    int status = NetFSMountURLSync((__bridge CFURLRef)url, NULL, (__bridge CFStringRef)user,
                                   (__bridge CFStringRef)password, (__bridge CFMutableDictionaryRef)open,
                                   (__bridge CFMutableDictionaryRef)mount, &points);
    NSArray *list = points ? CFBridgingRelease(points) : nil;
    if (status == 0) {
      NSString *first = list.count > 0 ? list[0] : nil;
      if ([first isKindOfClass:[NSString class]]) {
        job->mount_point = strdup(first.UTF8String);
      } else {
        status = ENOENT;
      }
    }
    job->status = status;
  }
}

static void mount_complete(napi_env env, napi_status napi_st, void *data) {
  MountJob *job = data;
  if (napi_st == napi_ok && job->status == 0 && job->mount_point) {
    napi_value result, point;
    napi_create_object(env, &result);
    napi_create_string_utf8(env, job->mount_point, NAPI_AUTO_LENGTH, &point);
    napi_set_named_property(env, result, "mountPoint", point);
    napi_resolve_deferred(env, job->deferred, result);
  } else {
    char message[64];
    snprintf(message, sizeof message, "SMB mount failed (%d)", job->status);
    napi_reject_deferred(env, job->deferred, make_error(env, message, job->status));
  }
  napi_delete_async_work(env, job->work);
  free(job->url);
  free(job->user);
  if (job->password) {
    memset(job->password, 0, strlen(job->password));
    free(job->password);
  }
  free(job->mount_point);
  free(job);
}

static napi_value NetfsMount(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  if (argc < 2) return throw_code(env, "expected url, user and password", EINVAL);
  MountJob *job = calloc(1, sizeof *job);
  if (!job) return throw_code(env, "out of memory", ENOMEM);
  job->url = copy_string(env, argv[0]);
  job->user = copy_string(env, argv[1]);
  if (job->user && job->user[0] == '\0') {
    free(job->user);
    job->user = NULL;
  }
  if (argc >= 3) job->password = copy_string(env, argv[2]); // `null` → NULL
  if (!job->url) {
    free(job->user);
    free(job->password);
    free(job);
    napi_throw_type_error(env, NULL, "expected a string for url");
    return NULL;
  }
  napi_value promise, name;
  napi_create_promise(env, &job->deferred, &promise);
  napi_create_string_utf8(env, "cairn.netfsMount", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, NULL, name, mount_execute, mount_complete, job, &job->work);
  napi_queue_async_work(env, job->work);
  return promise;
}

// MARK: - flock

static napi_value FlockTryExclusive(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  int fd;
  if (argc < 1 || !fd_arg(env, argv[0], &fd)) return NULL;
  int r;
  do {
    r = flock(fd, LOCK_EX | LOCK_NB);
  } while (r != 0 && errno == EINTR);
  napi_value result;
  if (r == 0) {
    napi_get_boolean(env, true, &result);
    return result;
  }
  if (errno == EWOULDBLOCK) {
    napi_get_boolean(env, false, &result);
    return result;
  }
  return throw_code(env, strerror(errno), errno);
}

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  int fd;
  int error;
} FlockJob;

static void flock_execute(napi_env env, void *data) {
  (void)env;
  FlockJob *job = data;
  int r;
  do {
    r = flock(job->fd, LOCK_EX);
  } while (r != 0 && errno == EINTR);
  job->error = r == 0 ? 0 : errno;
}

static void flock_complete(napi_env env, napi_status status, void *data) {
  FlockJob *job = data;
  if (status == napi_ok && job->error == 0) {
    napi_resolve_deferred(env, job->deferred, js_undefined(env));
  } else {
    int code = job->error ? job->error : EIO;
    napi_reject_deferred(env, job->deferred, make_error(env, strerror(code), code));
  }
  napi_delete_async_work(env, job->work);
  free(job);
}

static napi_value FlockExclusive(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  int fd;
  if (argc < 1 || !fd_arg(env, argv[0], &fd)) return NULL;
  FlockJob *job = calloc(1, sizeof *job);
  if (!job) return throw_code(env, "out of memory", ENOMEM);
  job->fd = fd;
  napi_value promise, name;
  napi_create_promise(env, &job->deferred, &promise);
  napi_create_string_utf8(env, "cairn.flockExclusive", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, NULL, name, flock_execute, flock_complete, job, &job->work);
  napi_queue_async_work(env, job->work);
  return promise;
}

static napi_value FlockUnlock(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  int fd;
  if (argc < 1 || !fd_arg(env, argv[0], &fd)) return NULL;
  if (flock(fd, LOCK_UN) != 0) return throw_code(env, strerror(errno), errno);
  return js_undefined(env);
}

// MARK: - Volume

static napi_value VolumeImportantCapacity(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t argc = 1;
    napi_value argv[1];
    CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
    if (argc < 1) return throw_code(env, "missing path", EINVAL);
    NSString *path = string_arg(env, argv[0], "path");
    if (!path) return NULL;
    NSURL *url = [NSURL fileURLWithPath:path];
    NSNumber *value = nil;
    if (![url getResourceValue:&value forKey:NSURLVolumeAvailableCapacityForImportantUsageKey error:NULL] || !value)
      return js_null(env);
    napi_value result;
    CHECK(napi_create_double(env, (double)value.longLongValue, &result));
    return result;
  }
}

// MARK: - Module

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
      {"keychainGetGeneric", NULL, KeychainGetGeneric, NULL, NULL, NULL, napi_enumerable, NULL},
      {"keychainSetGeneric", NULL, KeychainSetGeneric, NULL, NULL, NULL, napi_enumerable, NULL},
      {"keychainGetInternet", NULL, KeychainGetInternet, NULL, NULL, NULL, napi_enumerable, NULL},
      {"keychainSetInternet", NULL, KeychainSetInternet, NULL, NULL, NULL, napi_enumerable, NULL},
      {"netfsMount", NULL, NetfsMount, NULL, NULL, NULL, napi_enumerable, NULL},
      {"flockTryExclusive", NULL, FlockTryExclusive, NULL, NULL, NULL, napi_enumerable, NULL},
      {"flockExclusive", NULL, FlockExclusive, NULL, NULL, NULL, napi_enumerable, NULL},
      {"flockUnlock", NULL, FlockUnlock, NULL, NULL, NULL, napi_enumerable, NULL},
      {"volumeImportantCapacity", NULL, VolumeImportantCapacity, NULL, NULL, NULL, napi_enumerable, NULL},
  };
  if (napi_define_properties(env, exports, sizeof props / sizeof props[0], props) != napi_ok) return NULL;
  return exports;
}

NAPI_MODULE_INIT() { return Init(env, exports); }
