# Deployment Router

Load this reference first whenever the task crosses from building targets into
installing, packaging, releasing, or deploying them. Route by deliverable, not
by repository: one repository may publish a C++ SDK, an end-user executable,
and a Python module, and those are three separate contracts.

## First decide whether this is deployment

Stay in `../cmake-first-projects.md` and do not load a deployment leaf when all
consumers use the same configure tree through `add_subdirectory` or ordinary
target links. In-tree reuse alone does not justify install/export rules, package
config files, runtime bundling, or wheel machinery.

This is deployment when at least one consumer receives an installed prefix, a
source release archive, a runnable binary artifact, a native installer/package,
or a Python distribution.

Acquiring or wrapping a third-party dependency is not deployment. Route source
vendoring, package discovery, raw `.so`/`.a` SDKs, dependency diamonds, and ABI
mismatches through `../dependencies/router.md`. Return here only when a public
package must export that dependency or a runnable artifact must ship its runtime
files.

## Route by deliverable type

| Deliverable and consumer | Default contract | Load |
|---|---|---|
| Public C++ library consumed by another CMake build | Relocatable install tree, exported config/targets, source `.tar.gz` | `cmake-installable-projects.md` |
| Geek-oriented CLI whose users accept compiling | Textbook install target plus source `.tar.gz` | `cmake-installable-projects.md` |
| Community/end-user compiled application | Standalone executable, AppImage, or portable archive from a dedicated artifact pipeline | `cpp-app-deployment.md` |
| pybind11 extension imported by Python | Wheel-first Python packaging pipeline; optional intentional sdist | `pybind11-packaging.md` |

A CLI changes route when its audience changes. A developer tool may reasonably
default to source installation; a community-facing CLI meant to “download and
run” is an application artifact and follows `cpp-app-deployment.md`.

## Refine the distribution scope

Choose only the smallest scope the task actually requires:

1. **Same build tree:** no deployment leaf. Keep target wiring local.
2. **Source install:** public library or geek CLI; use the installable CMake
   route and verify the extracted `.tar.gz`.
3. **Portable application artifact:** compiled app; choose a standalone binary,
   AppImage, or relocatable zip/tar directory.
4. **Native system integration:** add MSI, DEB, RPM, or a customized installer
   only when menus, services, policy, upgrades, signing, or managed uninstall
   justify the platform-specific work.
5. **Ultimate cross-distro Linux artifact:** within the compiled-app route,
   consider a bundled loader plus glibc through `archibate/mockup` after the
   ordinary oldest-baseline/AppImage route is insufficient.
6. **Python ecosystem distribution:** within the pybind11 route, let the wheel
   platform/ABI matrix and Python installer own delivery.

Do not add every broader scope “for completeness.” A portable archive does not
automatically need DEB/RPM, a source-installable CLI does not automatically need
an exported CMake package, and a wheel does not automatically imply a public C++
SDK.

## Split mixed repositories into explicit pipelines

When one repository has multiple deliverables, load one leaf per deliverable and
keep their staging and verification boundaries distinct:

- a library install test consumes only the staged CMake package with
  `find_package`;
- an app deployment test launches only the final unpacked artifact on its
  support matrix;
- a pybind11 test installs the built wheel into a clean virtual environment and
  imports it.

Shared C++ targets may feed all three pipelines. Their package metadata,
runtime closure, compatibility promise, and release tests must not be conflated.
