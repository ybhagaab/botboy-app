import { describe, it, expect } from 'vitest';
import { classifyApp, type AppInfo } from './app-monitor.js';

describe('classifyApp', () => {
  it('detects VS Code as IDE', () => {
    const app: AppInfo = { name: 'Code', windowTitle: 'my-project — index.ts' };
    const result = classifyApp(app);
    expect(result.type).toBe('app_activity');
    expect(result.metadata.appCategory).toBe('ide');
    expect(result.metadata.projectName).toBe('my-project');
  });

  it('detects Kiro as IDE', () => {
    const app: AppInfo = { name: 'Kiro', windowTitle: 'tracker — main.ts' };
    const result = classifyApp(app);
    expect(result.metadata.appCategory).toBe('ide');
  });

  it('classifies a native Slack window as passive app activity', () => {
    const app: AppInfo = { name: 'Slack', windowTitle: 'general' };
    const result = classifyApp(app);
    expect(result.type).toBe('app_activity');
    expect(result.metadata.platform).toBe('native');
    expect(result.metadata.appCategory).toBe('messaging');
    expect(result.metadata.captureMode).toBe('passive_observation');
    expect(result.metadata.channelOrDm).toBe('general');
  });

  it('detects Notes app', () => {
    const app: AppInfo = { name: 'Notes', windowTitle: 'Meeting Notes' };
    const result = classifyApp(app);
    expect(result.type).toBe('app_activity');
    expect(result.metadata.appCategory).toBe('notes');
    expect(result.metadata.noteTitle).toBe('Meeting Notes');
  });

  it('detects document editors', () => {
    const app: AppInfo = { name: 'Microsoft Word', windowTitle: 'Report.docx' };
    const result = classifyApp(app);
    expect(result.metadata.appCategory).toBe('document_editor');
    expect(result.metadata.fileName).toBe('Report.docx');
  });

  it('falls back to generic for unknown apps', () => {
    const app: AppInfo = { name: 'Finder', windowTitle: 'Downloads' };
    const result = classifyApp(app);
    expect(result.type).toBe('app_activity');
    expect(result.metadata.appCategory).toBe('other');
  });

  it('extracts file path from IDE window title', () => {
    const app: AppInfo = { name: 'Code', windowTitle: 'project — src/utils.ts' };
    const result = classifyApp(app);
    expect(result.metadata.activeFilePath).toBe('src/utils.ts');
  });
});
