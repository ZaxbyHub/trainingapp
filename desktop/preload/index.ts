// Preload bridge for the TrainingApp desktop shell (issue #59).
//
// Deliberately EMPTY: the shell ships with no IPC surface at all. The renderer
// gets a namespaced, non-privileged object; contextIsolation keeps it that
// way. Workstream B2 (issue #60) fills this stub with the secured API when the
// loopback transport lands.
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('trainingapp', {});
