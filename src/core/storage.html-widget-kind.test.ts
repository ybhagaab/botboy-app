import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createStorage, migrateAnalyticsHtmlWidgetKind } from './storage.js';

/** html views (2026-10-09): an existing store gains kind='html' without losing a row, column, index, or binding. */
describe('migrateAnalyticsHtmlWidgetKind', () => {
  it('rebuilds only the CHECK, keeping rows, later columns, indexes, and referencing rows', () => {
    const storage = createStorage(':memory:');
    storage.initialize();
    const db = storage.getDb() as Database.Database;
    // Put the store back in its pre-html shape, as an old install has it.
    const revert = (name: string) => {
      const sql = String((db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string }).sql);
      const indexes = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL").all(name) as Array<{ sql: string }>).map(r => r.sql);
      db.pragma('foreign_keys = OFF');
      db.pragma('legacy_alter_table = ON'); // keep other tables' references on the real name
      db.exec(`ALTER TABLE ${name} RENAME TO ${name}_x`);
      db.exec(sql.replace("'visualization','html')", "'visualization')"));
      db.exec(`INSERT INTO ${name} SELECT * FROM ${name}_x; DROP TABLE ${name}_x;`);
      for (const index of indexes) db.exec(index);
      db.pragma('legacy_alter_table = OFF');
      db.pragma('foreign_keys = ON');
    };
    revert('analytics_widgets');
    revert('analytics_run_widgets');
    db.prepare("INSERT INTO analytics_dashboards (id, title) VALUES ('dash_1', 'D')").run();
    db.prepare("INSERT INTO analytics_widgets (id, dashboard_id, position, kind, title) VALUES ('widget_1', 'dash_1', 0, 'table', 'T')").run();
    expect(() => db.prepare("INSERT INTO analytics_widgets (id, dashboard_id, position, kind, title) VALUES ('widget_h', 'dash_1', 1, 'html', 'H')").run()).toThrow(/CHECK/);
    // A row that references the widget (ON DELETE CASCADE) must survive the rebuild.
    db.prepare("INSERT INTO analytics_widget_binding_revisions (widget_id, revision, updated_at) VALUES ('widget_1', 3, 'now')").run();
    const columnsBefore = (db.prepare('PRAGMA table_info(analytics_widgets)').all() as Array<{ name: string }>).map(c => c.name);

    migrateAnalyticsHtmlWidgetKind(db);
    migrateAnalyticsHtmlWidgetKind(db); // a second start changes nothing

    db.prepare("INSERT INTO analytics_widgets (id, dashboard_id, position, kind, title) VALUES ('widget_h', 'dash_1', 1, 'html', 'H')").run();
    expect(db.prepare('SELECT id, kind FROM analytics_widgets ORDER BY position').all()).toEqual([{ id: 'widget_1', kind: 'table' }, { id: 'widget_h', kind: 'html' }]);
    expect((db.prepare('PRAGMA table_info(analytics_widgets)').all() as Array<{ name: string }>).map(c => c.name)).toEqual(columnsBefore);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_analytics_widgets_dashboard'").get()).toBeTruthy();
    expect(db.prepare('SELECT widget_id, revision FROM analytics_widget_binding_revisions').all()).toEqual([{ widget_id: 'widget_1', revision: 3 }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(String((db.prepare("SELECT sql FROM sqlite_master WHERE name='analytics_run_widgets'").get() as { sql: string }).sql)).toContain("'html'");
  });
});
