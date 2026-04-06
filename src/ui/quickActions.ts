import * as vscode from 'vscode';
import { ChatViewProvider } from './chatView';

export interface QuickAction {
  id: string;
  label: string;
  icon: string;
  prompt: string;
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    id: 'explain',
    label: 'Explicar código',
    icon: '💡',
    prompt: 'Explicame qué hace este código paso a paso. Sé claro y conciso.',
  },
  {
    id: 'refactor',
    label: 'Refactorizar',
    icon: '🔧',
    prompt: 'Refactorizá este código para que sea más limpio, legible y mantenible. Explicá los cambios.',
  },
  {
    id: 'bugs',
    label: 'Buscar bugs',
    icon: '🐛',
    prompt: 'Analizá este código en busca de bugs, errores lógicos, edge cases no manejados y problemas de seguridad. Listá cada problema encontrado.',
  },
  {
    id: 'tests',
    label: 'Generar tests',
    icon: '🧪',
    prompt: 'Generá tests unitarios completos para este código. Incluí casos edge y nombres descriptivos.',
  },
  {
    id: 'docs',
    label: 'Documentar',
    icon: '📝',
    prompt: 'Agregá documentación completa a este código: JSDoc/docstrings, comentarios inline donde sea necesario, y un resumen breve.',
  },
  {
    id: 'optimize',
    label: 'Optimizar',
    icon: '⚡',
    prompt: 'Optimizá este código para mejor rendimiento. Explicá cada optimización y su impacto.',
  },
];

export function executeQuickAction(
  action: QuickAction,
  chatProvider: ChatViewProvider
): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('No hay editor activo.');
    return;
  }

  const selection = editor.document.getText(editor.selection);
  if (!selection) {
    vscode.window.showWarningMessage('Seleccioná código primero.');
    return;
  }

  const fileName = editor.document.fileName.split('/').pop() ?? 'archivo';
  const lang = editor.document.languageId;

  chatProvider.attachContext(`${action.icon} ${fileName} (${lang})`, selection);
  chatProvider.sendMessage(action.prompt);
  vscode.commands.executeCommand('apliarteAi.chatView.focus');
}
