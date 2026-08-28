# Compiled C++ Application Deployment

Use this route for an end-user application. Its primary contract is a runnable
artifact produced by a dedicated deployment pipeline, not a textbook source
installation. Source may still be published, but community users should not
need a compiler and a dependency scavenger hunt to launch the app.

## Choose the artifact for the audience

Prefer the smallest delivery surface that really satisfies the support matrix:

1. a genuinely standalone executable;
2. an AppImage, or at least a portable zip/tar directory;
3. native or customized installers such as MSI, DEB, RPM, or a self-extracting
   shell archive;
4. source installation as an expert fallback, not the app's primary UX.

Native packages are useful when desktop integration, policy, upgrades, or a
distribution repository matters. They also multiply platform-specific build,
metadata, signing, and test work. Do not generate every package format by
default.

## Build a relocatable runtime closure

A conventional Linux portable tree looks like this:

```text
MyApp/
|-- bin/myapp
|-- lib/libfoo.so
`-- share/myapp/...
```

The executable may be launched by a thin wrapper that prepends the bundle's
`lib/` to `LD_LIBRARY_PATH`, or it and its private libraries may be patched with
relative runtime search paths such as `$ORIGIN/../lib` and `$ORIGIN`.

Prefer relative `RUNPATH`/`RPATH` when the application launches host programs:
an inherited `LD_LIBRARY_PATH` can make `/bin/ls`, helper tools, or subprocesses
load incompatible bundled libraries. Resource lookup must also be relocatable;
do not compile `/usr/share/...` or the build prefix into the app.

CMake's `install(TARGETS ... RUNTIME_DEPENDENCIES ...)` or a platform deployment
tool can seed the closure. Treat the scan as a candidate set, not proof of
completeness. Add and test libraries loaded through `dlopen`, plugins, optional
backends, driver integrations, data files, locales, certificates, and helper
executables explicitly. Audit redistribution rights and preserve required
license notices for bundled third-party files.

## AppImage does not choose the ABI baseline

AppImage is a convenient executable-like filesystem and distribution format;
it is not itself a compiler, build system, or glibc compatibility layer. Its
official guidance still requires payload binaries to be built on a base system
no newer than the oldest intended target, to bundle non-baseline dependencies,
to avoid absolute paths, and to test every supported base system.

Do not describe the mounted filesystem image as a security sandbox. AppImage
changes artifact layout and launch mechanics; it does not by itself establish a
container-style trust boundary.

For the ordinary AppImage or portable-directory route, build on the oldest
glibc/libstdc++ baseline in the support policy. Code built against an older
symbol set generally has a wider chance of running on newer glibc systems; the
reverse is exactly what produces `GLIBC_x.y not found` or `GLIBCXX_x.y not
found`. Treat this as a tested compatibility policy, not a timeless guarantee.

Bundling application `.so` files alone does not remove that floor. The process
still starts through a dynamic loader and libc contract compatible with the
payload. A binary built on current Arch Linux can therefore fail before `main()`
on an older Ubuntu even when its obvious third-party libraries are present.

## Escalate to `archibate/mockup` for the loader-plus-libc closure

Use <https://github.com/archibate/mockup> when the requirement is an ultimate
cross-distro Linux bundle built on a newer host and the oldest-baseline route is
unacceptable. Its implementation recursively inspects trusted input binaries
with `ldd`, copies their discovered libraries—including libstdc++, glibc, and
the matching `ld-linux`—and launches the app through that bundled loader. It is
a compact packaging script, not a complete deployment system; pin a reviewed
revision in a release pipeline instead of downloading moving `main` implicitly.

Use an explicit output path in release automation. Single-file mode otherwise
modifies the input executable in place:

```bash
python mockup.py ./myapp -P -o myapp-bundle
python mockup.py ./myapp -P -S -o myapp-portable
```

These examples match the revision audited in `../sources.md`; verify the CLI and
wrapper behavior again when pinning a different revision.

- `-P` uses `patchelf` to set `$ORIGIN` `DT_RUNPATH` on the flat bundle. Its
  generated wrapper no longer sets `LD_LIBRARY_PATH`, which reduces library
  pollution when the app launches host executables. An already inherited
  `LD_LIBRARY_PATH` can still override `RUNPATH`, so sanitize the release test
  environment and do not call the result hermetic.
- Directory mode produces the app, its dependency files, the loader, and a
  launcher script; archive that directory as one release artifact.
- `-S` embeds a tar.gz payload in a Bash self-extracting executable. It gives a
  one-file handoff at the cost of extraction on every start and dependence on
  host shell/archive utilities.

Treat the generated wrapper as the stable directory-mode entrypoint. In the
current implementation, `-P` writes `PT_INTERP=./ld-linux-...`; directly
executing the patched ELF therefore relies on the process working directory,
whereas the wrapper resolves its own directory before invoking the loader.

This is substantially stronger than copying application libraries while still
not meaning “no dependencies”:

- Linux, CPU architecture, and the compiled ISA remain fixed; x86-64 does not
  run on ARM, and `-march=native` may exclude older x86-64 CPUs.
- The bundled glibc still depends on a compatible Linux kernel syscall ABI.
- `ldd` discovers the observed ELF dependency graph, not every future
  `dlopen`, plugin, NSS, GPU/graphics driver, or optional execution path.
- Executables, libraries, and data flattened by basename can collide. Inspect
  warnings and the final closure.
- The default unpatched wrapper appends the bundle after any existing
  `LD_LIBRARY_PATH`; it is not a sealed namespace, and an empty leading entry may
  admit the current directory. Prefer `-P` and a sanitized environment.
- Resource files, configuration, fonts, locale data, certificates, and external
  helpers remain the application's responsibility.
- glibc-adjacent runtime state such as NSS modules and configuration, DNS
  configuration, locale/gconv data, and timezone data is not captured merely by
  copying the `DT_NEEDED` graph. GPU and graphics driver matching is likewise a
  separate host-integration boundary.
- The directory launcher requires Bash and basic userland tools. The current
  single-file wrapper also uses `base64`, `tar`, gzip, and `mktemp`, and leaves
  its extracted temporary directory after `exec`; it is not suitable where
  `/tmp` is `noexec` or persistent extraction is unacceptable without further
  engineering.
- Run `ldd`/`mockup` only on artifacts built or otherwise trusted by the release
  process.
- Verify missing-dependency diagnostics independently. A parser around `ldd`
  output can itself miss or misclassify `not found` entries.

Do not repeat “runs on every Linux forever” as a release guarantee. State the
tested architecture, kernel/distro range, CPU floor, graphics/driver assumptions,
and unsupported plugin paths.

## Verify the release artifact, not the build tree

Test from an unpacked release in a clean environment with developer library
paths removed. Inspect the ELF interpreter, `NEEDED` entries, and relative
runtime paths with `readelf`; inspect `ldd` only for trusted artifacts. Exercise
startup, resource loading, optional plugins, subprocesses, and update/uninstall
behavior where applicable.

Run the exact artifact on the oldest and newest systems in the declared support
matrix, plus materially different distro families. A successful launch on the
build host proves almost nothing about deployment.
