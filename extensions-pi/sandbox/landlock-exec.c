/*
 * landlock-exec: apply Landlock IPC restrictions, then exec a command. Runs inside bwrap as the
 * sandbox's entry point, so paths are resolved in the sandbox's mount namespace.
 *
 *   landlock-exec [--scope-signal] [--allow-unix PATH]... -- COMMAND [ARG]...
 *
 * Always denies connecting to Unix sockets created outside the sandbox: pathname sockets via
 * LANDLOCK_ACCESS_FS_RESOLVE_UNIX (ABI 9) except beneath each --allow-unix PATH, and abstract
 * sockets via LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET. --scope-signal also denies signalling processes
 * outside the sandbox. Other filesystem access is left to bwrap's mounts. A missing --allow-unix
 * path is skipped. Exits 125 when Landlock is unavailable or too old, so the sandbox fails closed.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#define REQUIRED_ABI 9

static int fail(const char *what) {
	fprintf(stderr, "pi-sandbox: %s: %s\n", what, strerror(errno));
	return 125;
}

int main(int argc, char **argv) {
	int scope_signal = 0;
	int i = 1;
	for (; i < argc && strcmp(argv[i], "--") != 0; i++) {
		if (strcmp(argv[i], "--scope-signal") == 0) {
			scope_signal = 1;
		} else if (strcmp(argv[i], "--allow-unix") == 0 && i + 1 < argc) {
			i++;
		} else {
			fprintf(stderr, "pi-sandbox: landlock-exec: unknown argument %s\n", argv[i]);
			return 125;
		}
	}
	if (i + 1 >= argc) {
		fprintf(stderr, "usage: landlock-exec [--scope-signal] [--allow-unix PATH]... -- COMMAND [ARG]...\n");
		return 125;
	}

	long abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
	if (abi < REQUIRED_ABI) {
		fprintf(stderr, "pi-sandbox: Landlock ABI %d required, kernel provides %ld\n", REQUIRED_ABI, abi);
		return 125;
	}

	struct landlock_ruleset_attr attr = {
		.handled_access_fs = LANDLOCK_ACCESS_FS_RESOLVE_UNIX,
		.scoped = LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | (scope_signal ? LANDLOCK_SCOPE_SIGNAL : 0),
	};
	int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attr, sizeof attr, 0);
	if (ruleset < 0) return fail("landlock_create_ruleset");

	for (int j = 1; j < i; j++) {
		if (strcmp(argv[j], "--allow-unix") != 0) continue;
		const char *path = argv[++j];
		int fd = open(path, O_PATH | O_CLOEXEC);
		if (fd < 0) {
			if (errno == ENOENT) continue;
			return fail(path);
		}
		struct landlock_path_beneath_attr rule = { .allowed_access = LANDLOCK_ACCESS_FS_RESOLVE_UNIX, .parent_fd = fd };
		if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) != 0) return fail(path);
		close(fd);
	}

	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return fail("PR_SET_NO_NEW_PRIVS");
	if (syscall(SYS_landlock_restrict_self, ruleset, 0) != 0) return fail("landlock_restrict_self");
	close(ruleset);

	execvp(argv[i + 1], &argv[i + 1]);
	fprintf(stderr, "pi-sandbox: %s: %s\n", argv[i + 1], strerror(errno));
	return 127;
}
