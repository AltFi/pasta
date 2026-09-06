import { execFile } from "node:child_process";
import { app } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { InjectorResult } from "../shared/ipc";

function resourcesDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "engine")
    : path.join(__dirname, "..", "..", "resources");
}

export function getCliPath(): string {
  return path.join(resourcesDir(), "injector.exe");
}

export function getDllPath(): string {
  // Matches Pulse.vcxproj's actual build output name (Module.dll) —
  // "PulseRuntime.dll" was the old, unrelated Engine/Runtime backend's
  // output name and doesn't correspond to anything this build produces.
  // NOTE: this specific injector.exe locates its payload by scanning its own
  // directory for "module.dll" (case-insensitive on Windows/NTFS) — it takes
  // no --dll argument. Keeping this filename is what makes that pickup work.
  return path.join(resourcesDir(), "Module.dll");
}

// This injector.exe is our own Pool Party build (carrier-map + stolen
// IoCompletion, no CreateRemoteThread). It defaults its target to
// RobloxPlayerBeta.exe (argv[1] may override) and loads module.dll from
// beside itself (case-insensitive scan). We launch it WITHOUT arguments (the
// default target matches the UI's configured process), so it also writes
// stage progress to stderr. Exit code carries the contract:
//   0  = loader reported status=5 (payload entry executed)
//   1  = generic failure (target not found, map/trigger failed, handshake
//        timed out) -- details in stderr
//   2  = target is elevated and we are not (rerun as administrator)
const TARGET_PROCESS = "RobloxPlayerBeta.exe";

const INJECTOR_TIMEOUT_MS = 26000;

function runStage(exePath: string, args: string[], timeoutMs: number): Promise<InjectorResult> {
  return new Promise((resolve) => {
    // cwd matters here: this injector.exe finds "module.dll" next to itself
    // (it scans its own folder, case-insensitively) -- without an explicit
    // cwd, execFile defaults to this Electron process's own working
    // directory, not the injector's folder, so a relative-path lookup inside
    // the injector would silently miss the DLL entirely while the injector's
    // own process still exits 0.
    execFile(exePath, args, { timeout: timeoutMs, windowsHide: true, cwd: path.dirname(exePath) }, (error, stdout, stderr) => {
      const log = [stdout, stderr].filter(Boolean).join("\n").trim();
      const exitCode = error && typeof (error as NodeJS.ErrnoException).code === "number"
        ? ((error as unknown as { code: number }).code)
        : error
          ? -1
          : 0;
      // Injection reached the loader handshake: exit code 0 means the
      // payload entry actually executed (status=5), not merely that the
      // process spawned.
      const success = exitCode === 0;
      resolve({ success, log, exitCode });
    });
  });
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runStageElevated(exePath: string, args: string[], timeoutMs: number): Promise<InjectorResult> {
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const outFile = path.join(os.tmpdir(), `pulse-stage-${stamp}.out.log`);
  const errFile = path.join(os.tmpdir(), `pulse-stage-${stamp}.err.log`);

  // Start-Process's -Verb (elevation) and -RedirectStandardOutput/Error
  // parameters live in two DIFFERENT, mutually exclusive parameter sets --
  // PowerShell rejects any call that mixes them ("Parameter set cannot be
  // resolved") before it launches anything. The previous version of this
  // function did exactly that, so every elevated run failed at the
  // parameter-binding stage: injector.exe never even started, yet the
  // non-elevated attempt just before it (runStageAuto's `direct` call)
  // still reports exitCode 0 because it doesn't verify its OpenProcess/
  // section-map calls against Roblox actually succeeded -- so the whole
  // pipeline claimed success while never having injected anything.
  //
  // Fix: elevate cmd.exe itself (which -Verb RunAs supports) and let cmd's
  // own `>`/`2>` redirection -- running inside the elevated process -- write
  // the output files. cmd.exe exits with injector.exe's own exit code
  // (ERRORLEVEL propagates through `cmd /c`), so $p.ExitCode below is still
  // the real injector exit code, unchanged from before.
  const cmdLine = `/c "${exePath}"` +
    (args.length > 0 ? " " + args.map((a) => `"${a}"`).join(" ") : "") +
    ` > "${outFile}" 2> "${errFile}"`;

  const psArgs = [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$p = Start-Process -FilePath 'cmd.exe' ` +
      `-ArgumentList ${psQuote(cmdLine)} ` +
      `-WorkingDirectory ${psQuote(path.dirname(exePath))} ` +
      `-Verb RunAs -Wait -WindowStyle Hidden -PassThru; ` +
      `exit $p.ExitCode`,
  ];

  return new Promise((resolve, reject) => {
    execFile("powershell.exe", psArgs, { timeout: timeoutMs + 5000, windowsHide: true }, (error) => {
      const readSafe = (p: string) => {
        try {
          return fs.readFileSync(p, "utf-8");
        } catch {
          return "";
        }
      };
      const stdout = readSafe(outFile);
      const stderr = readSafe(errFile);
      try {
        fs.unlinkSync(outFile);
      } catch {
        /* best effort cleanup */
      }
      try {
        fs.unlinkSync(errFile);
      } catch {
        /* best effort cleanup */
      }

      // powershell.exe's own exit code is now the elevated injector's real
      // exit code, via `exit $p.ExitCode` above — not a guess.
      const exitCode = error && typeof (error as NodeJS.ErrnoException).code === "number"
        ? ((error as unknown as { code: number }).code)
        : error
          ? -1
          : 0;

      if (exitCode === -1) {
        reject(new Error("Elevation was declined or the admin process failed to launch"));
        return;
      }

      const log = [stdout, stderr].filter(Boolean).join("\n").trim();
      const success = exitCode === 0;
      resolve({ success, log: log || "(no output from the elevated process)", exitCode });
    });
  });
}

function needsElevation(result: InjectorResult): boolean {
  return /administrator|admin|elevated/i.test(result.log) || result.exitCode === 2;
}

async function runStageAuto(exePath: string, args: string[], timeoutMs: number, label: string): Promise<InjectorResult> {
  const direct = await runStage(exePath, args, timeoutMs);
  if (direct.success || !needsElevation(direct)) return direct;

  try {
    return await runStageElevated(exePath, args, timeoutMs);
  } catch (err) {
    return {
      success: false,
      log: `${direct.log}\n\n[${label}] ${err instanceof Error ? err.message : String(err)}`,
      exitCode: direct.exitCode,
    };
  }
}

function section(title: string, result: InjectorResult): string {
  return `--- ${title} ---\n${result.log || "(no output)"}`;
}

export async function runInjector(processName: string): Promise<InjectorResult> {
  const cliPath = getCliPath();
  const dllPath = getDllPath();

  if (!fs.existsSync(cliPath)) {
    return { success: false, log: `injector.exe not found at: ${cliPath}`, exitCode: null };
  }
  if (!fs.existsSync(dllPath)) {
    return { success: false, log: `Engine module not found at: ${dllPath}`, exitCode: null };
  }

  const trimmed = processName.trim();
  if (!trimmed || !/^[\w.\-]+\.exe$/i.test(trimmed)) {
    return { success: false, log: `Invalid process name: "${processName}"`, exitCode: null };
  }

  // This injector.exe takes no arguments in production — it defaults to its
  // built-in target (RobloxPlayerBeta.exe) and finds module.dll next to
  // itself. If the UI's configured process name doesn't match, warn rather
  // than silently injecting into the wrong (or no) process.
  if (trimmed.toLowerCase() !== TARGET_PROCESS.toLowerCase()) {
    return {
      success: false,
      log: `This injector only targets ${TARGET_PROCESS} (hardcoded in the binary) — configured process is "${trimmed}". Update the target process to ${TARGET_PROCESS} to proceed.`,
      exitCode: null,
    };
  }

  const inject = await runStageAuto(cliPath, [], INJECTOR_TIMEOUT_MS, "inject");

  return {
    success: inject.success,
    log: section("injector.exe", inject),
    exitCode: inject.exitCode,
  };
}
