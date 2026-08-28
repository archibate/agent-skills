# pybind11 Modules in Python Packaging Pipelines

Use this route for a C++ extension imported by Python. The Python package is the
delivery unit. CMake builds and stages the native module; `pyproject.toml` and
the Python build backend own wheels, source distributions, installation, and
platform tags.

## Keep CMake subordinate to the Python package

Declare a normal pybind11 module target and attach its C++ requirements through
targets:

```cmake
find_package(pybind11 CONFIG REQUIRED)

pybind11_add_module(_native src/python_bindings.cpp)
target_link_libraries(_native PRIVATE project_core)

install(TARGETS _native
  LIBRARY DESTINATION mypackage
  RUNTIME DESTINATION mypackage
)
```

The install destination is the import location inside the wheel staging tree,
not `/usr/lib` and not a standalone CMake package prefix. Use `DESTINATION .`
only when the extension intentionally lives at the Python distribution root;
normally it belongs inside the import package.

Use the repository's existing Python backend. For a new CMake-first pybind11
package, scikit-build-core is the direct route documented by pybind11:

```toml
[build-system]
requires = ["scikit-build-core", "pybind11"]
build-backend = "scikit_build_core.build"
```

Do not add a parallel hand-written `setup.py` path unless compatibility with an
existing project requires it. The backend configures CMake, installs into its
wheel staging prefix, and packages the result.

## Model native boundaries deliberately

- Keep the binding translation unit thin. Link it to the same CMake target that
  production C++ consumers use; do not duplicate core sources in the extension.
- Prefer an `OBJECT` core when it is an internal module folded into the extension
  in the same configure tree. Use `STATIC` only when a deliberate archive or SDK
  boundary independently requires it. When either kind is linked into the
  pybind11 module on ELF platforms, set `POSITION_INDEPENDENT_CODE` on the core
  target; do not hand-write a compiler PIC flag. Hide internal symbols and expose
  the Python API as the stable user boundary.
- If the project also publishes a public C++ SDK, treat that as a second,
  explicit deliverable using `cmake-installable-projects.md`. Do not make wheel
  installation masquerade as a system C++ package.
- A wheel containing extra shared libraries needs a platform-relative runtime
  lookup and the platform's wheel repair/bundling step. Do not rely on a
  developer's `LD_LIBRARY_PATH`.
- Python version, Python ABI, OS, architecture, libc policy, and CPU ISA all
  affect wheel compatibility. Build the wheel matrix promised by the package;
  do not rename an artifact to a broader tag than it earned.

Prefer wheels for end users. Publish an sdist only when a source-build path is
intentional and the archive contains every file required by the backend and
CMake configure. An sdist is not proof that arbitrary user machines have a
suitable compiler or native dependencies.

## Test through installation and import

Build the exact wheel, install it into a clean virtual environment, and test the
public Python import and at least one native call. Do not import from the source
or CMake build tree: those paths can hide a missing installed module, bad RPATH,
wrong package destination, undeclared Python dependency, or accidentally loaded
host library.

Run these tests for each supported wheel tag and on the oldest runtime baseline
claimed by that tag. Keep C++ unit tests for the core target and Python tests for
binding conversions, exceptions, lifetimes, GIL behavior, and import/package
layout; neither layer substitutes for the other.
