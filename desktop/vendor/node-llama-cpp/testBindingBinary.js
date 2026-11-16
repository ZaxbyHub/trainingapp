import { fork } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { createRequire } from "module";
import path from "path";
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const detectedFileName = path.basename(__filename);
const expectedFileName = "testBindingBinary";
// trainingapp issue #350 (trace 350-351-packaged-gpu-fuse-external-timeouts):
// VENDORED PATCH of node-llama-cpp 3.22.3's testBindingBinary.js. Upstream force-
// tests prebuilt GPU binaries before loading by FORKING a test process; inside an
// Electron utility process the `electron` module does not export `utilityProcess`
// (executed probe, trace 02 R1), so the node-fork leg spawns process.execPath —
// the packaged GUI binary, which the runAsNode fuse (deliberately ON/OFF boundary,
// electron-builder.yml electronFuses.runAsNode: false) refuses to run as Node —
// and getLlama silently falls back to CPU. This copy adds ONE surgical capability:
// when ALREADY running inside a disposable Electron utility process
// (runningInElectron && process.parentPort != null), the binding test runs
// IN-PROCESS using the EXACT upstream child-leg body, instead of forking.
//
// Layout notes (both execution sites):
//  - Packaged: electron-builder's files remap installs THIS FILE at
//    node_modules/node-llama-cpp/dist/bindings/utils/testBindingBinary.js, where
//    getLlama's static import loads it. Relative sibling imports would work there,
//    but the dev-side frozen checks import this file from desktop/vendor/... where
//    they would NOT resolve — so every sibling is imported LAZILY from the
//    INSTALLED dist root (createRequire.resolve("node-llama-cpp") -> dist/index.js).
//    Node-llama-cpp's exports map does not export deep paths
//    (ERR_PACKAGE_PATH_NOT_EXPORTED for direct deep specifiers), hence the
//    dist-root + relative-path join.
//  - Host state (process.versions.electron / process.parentPort) is read LAZILY
//    inside the decision points: importing the upstream runtime.js constant at
//    module load would freeze the branch decision at first-import order.
//  - All non-utility execution paths keep upstream behavior byte-for-byte (fork
//    legs, child-leg protocol block at the bottom, bundled-name and SEA escapes).
//  - The PRISTINE.sha256 file beside this one pins the unpatched upstream file's
//    hash + version; desktop/src/__tests__/packaged-vulkan-binding.test.ts fails
//    loudly on any node-llama-cpp bump until the patch is re-verified.

const requireNlc = createRequire(import.meta.url);

let cachedDistRoot = null;
function nlcDistRoot() {
    if (cachedDistRoot == null) {
        // dist/index.js -> dist/
        cachedDistRoot = path.dirname(requireNlc.resolve("node-llama-cpp"));
    }
    return cachedDistRoot;
}

async function importNlcSibling(relativePath) {
    return import(pathToFileURL(path.join(nlcDistRoot(), relativePath)).href);
}

/** Lazily resolve the host flags (never a load-time constant). */
async function resolveHostState() {
    const inElectron = process.versions.electron != null;
    const inBun = process.versions.bun != null;
    const hasParentPort = process.parentPort != null;
    let utilityAvailable = false;
    if (inElectron) {
        try {
            const electronModule = await import("electron");
            utilityAvailable = electronModule.utilityProcess != null;
        }
        catch (err) {
            // do nothing (upstream getForkFunction semantics)
        }
    }
    return { inElectron, inBun, hasParentPort, utilityAvailable };
}

// Module-side result cache (issue trace 05: an OPTIMIZATION, not a double-init
// suppressor — successful in-process results skip re-running the test on a
// second call within this module instance; FALSE/throwing results are NOT
// cached so a later CPU getLlama still loads cleanly).
const inProcessTestCache = new Map();

export async function testBindingBinary(bindingBinaryPath, extBackendsPath, gpu, testTimeout = 1000 * 60 * 5, pipeOutputOnNode = false) {
    if (!detectedFileName.startsWith(expectedFileName)) {
        console.warn(getConsoleLogPrefixSync() +
            `"${expectedFileName}.js" file is not independent, so testing a binding binary with the current system ` +
            "prior to importing it cannot be done.\n" +
            getConsoleLogPrefixSync() +
            "Assuming the test passed with the risk that the process may crash due to an incompatible binary.\n" +
            getConsoleLogPrefixSync() +
            'To resolve this issue, make sure that "node-llama-cpp" is not bundled together with other code and is imported as an external module with its original file structure.');
        return true;
    }
    try {
        const inSnapOnLinux = await (async () => {
            const { getPlatform } = await importNlcSibling("bindings/utils/getPlatform.js");
            return getPlatform() === "linux" && process.env.SNAP != null;
        })();
        if (inSnapOnLinux && !((await resolveHostState()).inBun) && !((await resolveHostState()).inElectron)) {
            const nodeSea = await import("node:sea");
            if (nodeSea.isSea()) {
                const { newGithubIssueUrl } = await importNlcSibling("config.js");
                console.warn(getConsoleLogPrefix() +
                    "node SEA is detected, so testing a binding binary with the current system prior to importing it cannot be done.\n" +
                    getConsoleLogPrefix() +
                    "Assuming the test passed with the risk that the process may crash due to an incompatible binary.\n" +
                    getConsoleLogPrefix() +
                    "If this is an issue in your case, " +
                    "please open an issue on GitHub with the details of the environment where this happens: " + newGithubIssueUrl);
                return true;
            }
        }
    }
    catch (err) {
        // do nothing
    }
    // trainingapp #350: IN-PROCESS branch — we are already the disposable
    // utility process; forking cannot work under the runAsNode fuse (the node
    // leg spawns the packaged GUI binary) and the electron leg is unavailable
    // (no utilityProcess export inside a utility process). Run the EXACT
    // upstream child-leg body here, report true/false, and surface the real
    // rejection through console.error (the single reason channel the probe
    // child taps).
    const host = await resolveHostState();
    if (host.inElectron && host.hasParentPort) {
        const cacheKey = `${bindingBinaryPath}|${String(gpu)}`;
        if (inProcessTestCache.has(cacheKey)) {
            return inProcessTestCache.get(cacheKey);
        }
        const result = await testBindingBinaryInProcess(bindingBinaryPath, extBackendsPath, gpu);
        if (result === true) {
            inProcessTestCache.set(cacheKey, true);
        }
        return result;
    }
    async function getForkFunction() {
        if (host.inElectron) {
            if (host.utilityAvailable) {
                return {
                    type: "electron",
                    fork: (await import("electron")).utilityProcess.fork.bind((await import("electron")).utilityProcess)
                };
            }
            // Upstream swallowed a missing utilityProcess here and fell through to
            // the node leg — the exact defect #350 fixes; keep the fall-through
            // shape for non-utility electron contexts (e.g. dev main process).
        }
        return {
            type: "node",
            fork
        };
    }
    const forkFunction = await getForkFunction();
    function createTestProcess({ onMessage, onExit }) {
        if (forkFunction.type === "electron") {
            let exited = false;
            const subProcess = forkFunction.fork(__filename, [], {
                env: {
                    ...process.env,
                    TEST_BINDING_CP: "true"
                }
            });
            function cleanupElectronFork() {
                if (subProcess.pid != null || !exited) {
                    subProcess.kill();
                    exited = true;
                }
                process.off("exit", cleanupElectronFork);
            }
            process.on("exit", cleanupElectronFork);
            subProcess.on("message", onMessage);
            subProcess.on("exit", (code) => {
                exited = true;
                cleanupElectronFork();
                onExit(code);
            });
            return {
                sendMessage: (message) => subProcess.postMessage(message),
                killProcess: cleanupElectronFork,
                pipeMessages: () => void 0
            };
        }
        let pipeSet = false;
        const subProcess = forkFunction.fork(__filename, [], {
            detached: false,
            silent: true,
            stdio: pipeOutputOnNode
                ? ["ignore", "pipe", "pipe", "ipc"]
                : ["ignore", "ignore", "ignore", "ipc"],
            env: {
                ...process.env,
                TEST_BINDING_CP: "true"
            }
        });
        function cleanupNodeFork() {
            subProcess.stdout?.off("data", onStdout);
            subProcess.stderr?.off("data", onStderr);
            if (subProcess.exitCode == null)
                subProcess.kill("SIGKILL");
            process.off("exit", cleanupNodeFork);
        }
        process.on("exit", cleanupNodeFork);
        subProcess.on("message", onMessage);
        subProcess.on("exit", (code) => {
            cleanupNodeFork();
            onExit(code ?? -1);
        });
        if (subProcess.killed || subProcess.exitCode != null) {
            cleanupNodeFork();
            onExit(subProcess.exitCode ?? -1);
        }
        function onStdout(data) {
            if (!pipeSet)
                return;
            process.stdout.write(data);
        }
        function onStderr(data) {
            if (!pipeSet)
                return;
            process.stderr.write(data);
        }
        if (pipeOutputOnNode) {
            subProcess.stdout?.on("data", onStdout);
            subProcess.stderr?.on("data", onStderr);
        }
        function pipeMessages() {
            if (!pipeOutputOnNode || pipeSet)
                return;
            pipeSet = true;
        }
        return {
            sendMessage: (message) => subProcess.send(message),
            killProcess: cleanupNodeFork,
            pipeMessages
        };
    }
    let testPassed = false;
    let forkSucceeded = false;
    let timeoutHandle = null;
    let subProcess = undefined;
    let testFinished = false;
    function cleanup() {
        testFinished = true;
        if (timeoutHandle != null)
            clearTimeout(timeoutHandle);
        subProcess?.killProcess();
    }
    return Promise.race([
        new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                reject(new Error("Binding binary load test timed out"));
                cleanup();
            }, testTimeout);
        }),
        new Promise((resolve, reject) => {
            function done() {
                if (!forkSucceeded)
                    reject(new Error(`Binding binary test failed to run a test process via file "${__filename}"`));
                else
                    resolve(testPassed);
                cleanup();
            }
            subProcess = createTestProcess({
                onMessage(message) {
                    if (message.type === "ready") {
                        forkSucceeded = true;
                        subProcess.sendMessage({
                            type: "start",
                            bindingBinaryPath,
                            extBackendsPath,
                            gpu
                        });
                    }
                    else if (message.type === "loaded") {
                        subProcess.pipeMessages(); // only start piping error logs if the binary loaded successfully
                        subProcess.sendMessage({
                            type: "test",
                            bindingBinaryPath,
                            extBackendsPath,
                            gpu
                        });
                    }
                    else if (message.type === "done") {
                        testPassed = true;
                        subProcess.sendMessage({ type: "exit" });
                    }
                },
                onExit(code) {
                    if (code !== 0)
                        testPassed = false;
                    done();
                }
            });
            if (testFinished)
                subProcess.killProcess();
        })
    ]);
}

/**
 * The EXACT upstream child-leg body (testBindingBinary.js:213-258), executed
 * in-process. Returns true on success; on ANY failure console.errors the
 * field-shaped rejection line (mirroring getLlama.js:462-472's wording so the
 * probe child's reason plumbing can surface it) and returns false — a native
 * crash of a genuinely incompatible binary still takes down this disposable
 * utility process, which the parent transport classifies as a cpu verdict.
 */
async function testBindingBinaryInProcess(bindingBinaryPath, extBackendsPath, gpu) {
    const { getConsoleLogPrefix } = await importNlcSibling("utils/getConsoleLogPrefix.js");
    const { LlamaLogLevelToAddonLogLevel } = await importNlcSibling("bindings/Llama.js");
    const { defaultBindingTestLogLevel } = await importNlcSibling("config.js");
    try {
        const binding = require(bindingBinaryPath);
        const errorLogLevel = LlamaLogLevelToAddonLogLevel.get(defaultBindingTestLogLevel);
        if (errorLogLevel != null)
            binding.setLoggerLogLevel(errorLogLevel);
        // loaded (upstream sends {type:"loaded"} to the forked child here)
        binding.loadBackends();
        let loadedGpu = binding.getGpuType();
        if (loadedGpu == null || (loadedGpu === false && gpu !== false)) {
            const backendsPath = path.dirname(path.resolve(bindingBinaryPath));
            const fallbackBackendsDir = path.join(path.resolve(extBackendsPath ?? backendsPath), "fallback");
            binding.loadBackends(backendsPath);
            loadedGpu = binding.getGpuType();
            if (loadedGpu == null || (loadedGpu === false && gpu !== false))
                binding.loadBackends(fallbackBackendsDir);
        }
        await binding.init();
        binding.getGpuVramInfo();
        binding.getGpuDeviceInfo();
        try {
            await binding.getSystemMemoryInfo();
        }
        catch (err) {
            // do nothing (upstream swallows)
        }
        const gpuType = binding.getGpuType();
        void gpuType;
        if (gpuType !== gpu)
            throw new Error("Binary GPU type mismatch. " +
                `Expected: ${gpu}, got: ${gpuType}. ` + (gpu === "cuda"
                ? "May be due to a linker issue, ensure you don't have multiple conflicting CUDA installations."
                : "May be due to a linker issue, ensure the native dependencies are not broken."));
        binding.ensureGpuDeviceIsSupported();
        return true;
    }
    catch (err) {
        console.error(getConsoleLogPrefix() +
            `Failed to load a prebuilt binary for platform "${process.platform}" with ${gpu === false ? "CPU" : String(gpu)} support, falling back to using CPU. Error:`, err);
        return false;
    }
}

/** Sibling-free prefix used before the lazy siblings are loaded (the bundled-
 *  name escape runs before any import in the vendored layout). */
function getConsoleLogPrefixSync() {
    return "";
}

if (process.env.TEST_BINDING_CP === "true" && (process.parentPort != null || process.send != null)) {
    let binding;
    const sendMessage = process.parentPort != null
        ? (message) => process.parentPort.postMessage(message)
        : (message) => process.send(message);
    const onMessage = async (message) => {
        if (message.type === "start") {
            try {
                binding = require(message.bindingBinaryPath);
                const { LlamaLogLevelToAddonLogLevel } = await importNlcSibling("bindings/Llama.js");
                const { defaultBindingTestLogLevel } = await importNlcSibling("config.js");
                const errorLogLevel = LlamaLogLevelToAddonLogLevel.get(defaultBindingTestLogLevel);
                if (errorLogLevel != null)
                    binding.setLoggerLogLevel(errorLogLevel);
                sendMessage({ type: "loaded" });
            }
            catch (err) {
                console.error(err);
                process.exit(1);
            }
        }
        else if (message.type === "test") {
            try {
                if (binding == null)
                    throw new Error("Binding binary is not loaded");
                binding.loadBackends();
                let loadedGpu = binding.getGpuType();
                if (loadedGpu == null || (loadedGpu === false && message.gpu !== false)) {
                    const backendsPath = path.dirname(path.resolve(message.bindingBinaryPath));
                    const fallbackBackendsDir = path.join(path.resolve(message.extBackendsPath ?? backendsPath), "fallback");
                    binding.loadBackends(backendsPath);
                    loadedGpu = binding.getGpuType();
                    if (loadedGpu == null || (loadedGpu === false && message.gpu !== false))
                        binding.loadBackends(fallbackBackendsDir);
                }
                await binding.init();
                binding.getGpuVramInfo();
                binding.getGpuDeviceInfo();
                try {
                    await binding.getSystemMemoryInfo();
                }
                catch (err) {
                    // do nothing
                }
                const gpuType = binding.getGpuType();
                void gpuType;
                if (gpuType !== message.gpu)
                    throw new Error("Binary GPU type mismatch. " +
                        `Expected: ${message.gpu}, got: ${gpuType}. ` + (message.gpu === "cuda"
                        ? "May be due to a linker issue, ensure you don't have multiple conflicting CUDA installations."
                        : "May be due to a linker issue, ensure the native dependencies are not broken."));
                binding.ensureGpuDeviceIsSupported();
                sendMessage({ type: "done" });
            }
            catch (err) {
                console.error(err);
                process.exit(1);
            }
        }
        else if (message.type === "exit") {
            process.exit(0);
        }
    };
    if (process.parentPort != null)
        process.parentPort.on("message", (message) => onMessage(message.data));
    else
        process.on("message", onMessage);
    sendMessage({ type: "ready" });
}
//# sourceMappingURL=testBindingBinary.js.map
