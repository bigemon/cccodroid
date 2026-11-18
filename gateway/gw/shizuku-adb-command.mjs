// Match Env.java's execution mode. An unconditional linker launch makes adb
// see linker64 as /proc/self/exe and re-exec it with adb's "-L" server arguments.
export function adbCommand(binary, args, environment) {
  const env = { ...environment };
  if (env.CCAPP_EXEC === "loader") {
    // The installed bionic exec shim/termux-exec use this for readlink(self/exe)
    // and for adb's child-server exec. The child must see adb, not the parent node.
    env.TERMUX_EXEC__PROC_SELF_EXE = binary;
    if (env.CCAPP_BIONIC_PRELOAD) env.LD_PRELOAD = env.CCAPP_BIONIC_PRELOAD;
    return { binary: "/system/bin/linker64", args: [binary, ...args], env };
  }
  delete env.TERMUX_EXEC__PROC_SELF_EXE;
  return { binary, args: [...args], env };
}
