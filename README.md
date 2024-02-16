# VSCode - Systemtap assistant

![Screenshot](/screenshot.png?raw=true "Screenshot")

This extension helps you trace kernel code using Systemtap.

It offers two features:
- it lets you select functions or lines of code in a Linux kernel workspace
  (with the right-click context menu or via commands) and appends them as probe
  points at the end of a systemtap script. By default, these probe points call
  the `trace_call()`, `trace_return()` and `trace_line()` functions.
- it listens for packets on a UDP port (`65530` by default) and spawns a VSCode
  buffer with a live logs feed when a new session is started (as indicated by
  the `===CLEAR===` special log).

If the output systemtap script doesn't exist yet, it will also generate a
default preamble for it. The default preamble can be re-configured or freely
modified after it's been generated.

The provided default preamble defines implementations of the `trace_call()`,
`trace_return()` and `trace_line()` functions which log the current process
name, pid, function name, and parameters (on call probes), return values (on
return probes) or local variables (on line probes), with deep argument
inspection on structure pointers. These logs are shipped as UDP packets on a
dynamically configurable ethernet interface. This survives kernel panics and
lets VSCode render traces in a log buffer. Users are free to use other
preambles or to modify probe points after they are generated.

You can configure `systemtap-assistant.output` to a different output path and
`systemtap-assistant.deploy-task` to the name of a task that should be run
after this extension appended probes to the script. This task can typically be
used to compile and deploy the tracer module to a development target.

Examples of commands that can be used in deploy tasks are:

```
# Compile a tracer.ko against the kernel built in the current directory
stap -p4 -g -r `pwd` -m tracer tracer.stp

# On a target, load the tracer module and have it output to the default route
DEFAULT_ROUTE=`ip route show default | awk '/dev/ {print $5}'`

# Run ls and use its PID as target(). This only trace events from ls children
staprun tracer.ko interface=${DEFAULT_ROUTE} -c ls
```