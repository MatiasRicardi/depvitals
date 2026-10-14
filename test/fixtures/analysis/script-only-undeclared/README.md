# No source files

This fixture declares a dependency and a script that references an **undeclared** tool. The declared
dependency is reported as unused, and the undeclared script command must never create a missing
dependency (scripts never generate missing findings).
