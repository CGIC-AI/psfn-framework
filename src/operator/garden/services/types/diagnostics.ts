import type {
  RuntimeDiagnosticsQuery,
  RuntimeDiagnosticsSnapshot,
} from '../../../../shared/diagnostics/runtime-diagnostics.js';

export interface AdminDiagnosticsService {
  getDiagnostics(query?: RuntimeDiagnosticsQuery): Promise<RuntimeDiagnosticsSnapshot>;
}
