// @vitest-environment jsdom
//
// The generated-document reader names where a publication lands (owner report 2026-11-13: with Google Drive connected and Amazon
// Employee off, the reader still said SharePoint). The publication drawer is rendered straight from dashboard.js with the real
// document-publication.js words; only the page's state and small formatters are stubbed.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as pub from './document-publication.js';

const dashboard = readFileSync(path.join(process.cwd(), 'src/ui/dashboard.js'), 'utf8');
function topLevel(name: string): string {
  const start = dashboard.search(new RegExp(`\\n(?:async )?function ${name}\\(`));
  expect(start, `missing function ${name}`).toBeGreaterThanOrEqual(0);
  return dashboard.slice(start, dashboard.indexOf('\n}\n', start) + 2);
}
function constLine(name: string): string {
  const match = dashboard.match(new RegExp(`\\nconst ${name} = .*\\n`));
  expect(match, `missing const ${name}`).not.toBeNull();
  return match![0];
}

function panel(input: { amazon: boolean; drive: boolean; view: any; artifact?: any; draft?: any }): string {
  const source = [
    constLine('providerPlace'), topLevel('publicationAvailability'), topLevel('lockWaitClock'), topLevel('lockWaitText'), topLevel('renderDocumentPublicationPanel'),
    'return renderDocumentPublicationPanel;',
  ].join('\n');
  // eslint-disable-next-line no-new-func
  const render = new Function(
    'GOOGLE_DRIVE', 'SHAREPOINT', 'publicationPlace', 'publicationPresentation', 'publicationEffectLabel', 'locationPlace',
    'publicationAttemptCanApply', 'defaultPublicationDraft', 'amazonEmployeeOn', 'drivePublishAvailable',
    'publicationOperationBusy', 'icon', 'esc', 'attr', 'relativeTime', 'documentStateLabel', 'number',
    source,
  )(
    pub.GOOGLE_DRIVE, pub.SHAREPOINT, pub.publicationPlace, pub.publicationPresentation, pub.publicationEffectLabel, pub.locationPlace,
    pub.publicationAttemptCanApply, pub.defaultPublicationDraft, () => input.amazon, () => input.drive,
    () => false, () => '', (value: unknown) => String(value ?? '').replace(/[&<>"]/g, ch => `&#${ch.charCodeAt(0)};`),
    (value: unknown) => String(value ?? '').replace(/"/g, '&quot;'), () => 'just now', (value: string) => String(value || ''), (value: number) => String(value),
  );
  const artifact = { artifactId: 'art_1', publicationDestinations: input.drive ? [{ label: 'My Drive · BotBoy', accountId: 'default', folderId: 'fld' }] : [], ...input.artifact };
  return render(artifact, input.view, { publicationOpen: true, publicationTrigger: 'toolbar', publicationDraft: input.draft ?? null, publicationError: '' });
}
const notPublished = { phase: 'create_configuration_required', completedLocations: [], updateBases: [], currentLocationCount: 0 };
const driveCopy = { publicationId: 'p1', serverRelativeUrl: 'My Drive/BotBoy/PRD.docx', containsSelectedArtifact: true, format: 'docx', destination: { provider: 'gdrive', receipt: 'exact file verified' } };
const sharePointCopy = { publicationId: 'p2', serverRelativeUrl: '/personal/u/Documents/PRD.docx', containsSelectedArtifact: true, format: 'docx' };

describe('where a publication lands, in words', () => {
  it('reads the destination from the attempt, then the copies, then what can take it', () => {
    expect(pub.publicationPlace({ attempt: { destination: { provider: 'gdrive' } } }, { sharepoint: true, drive: false })).toBe('Google Drive');
    expect(pub.publicationPlace({ attempt: {} }, { sharepoint: false, drive: true })).toBe('SharePoint');
    expect(pub.publicationPlace({ completedLocations: [driveCopy] })).toBe('Google Drive');
    expect(pub.publicationPlace({ completedLocations: [sharePointCopy] })).toBe('SharePoint');
    expect(pub.publicationPlace({ completedLocations: [driveCopy, sharePointCopy] })).toBeNull();
    expect(pub.publicationPlace(notPublished, { sharepoint: false, drive: true })).toBe('Google Drive');
    expect(pub.publicationPlace(notPublished, { sharepoint: true, drive: true })).toBeNull();
    expect(pub.publicationPlace(notPublished, { sharepoint: true, drive: false })).toBe('SharePoint');
    expect(pub.publicationPlace(notPublished)).toBe('SharePoint');
  });

  it('every phase\'s words name the place, or none when it is not one place; SharePoint-only words are unchanged', () => {
    const phases = ['blocked_unassigned', 'create_configuration_required', 'update_ready', 'update_base_selection_required', 'pending', 'approved', 'in_flight', 'conflicted', 'failed', 'complete'];
    for (const phase of phases) {
      const words = (place: string | null) => JSON.stringify(pub.publicationPresentation({ phase, currentLocationCount: 2 }, { place }));
      expect(words('Google Drive'), phase).not.toContain('SharePoint');
      expect(words(null), phase).not.toMatch(/SharePoint(?! or Google Drive)/);
      expect(words(null), phase).not.toContain('Google Drive copy');
    }
    expect(pub.publicationPresentation(notPublished, { place: 'Google Drive' })).toMatchObject({ button: 'Publish to Google Drive…', summary: 'Choose a Google Drive folder and how to store it.' });
    expect(pub.publicationPresentation(notPublished, { place: null })).toMatchObject({ button: 'Publish…' });
    expect(pub.publicationPresentation({ phase: 'complete', currentLocationCount: 1 }, { place: 'Google Drive' }).label).toBe('Current on Google Drive');
    // Left out, the place is read from the view as before: the SharePoint words stay exactly as they were.
    expect(pub.publicationPresentation(notPublished)).toMatchObject({ label: 'Not published', summary: 'Choose an exact SharePoint destination and format.', button: 'Publish to SharePoint…' });
    expect(pub.publicationPresentation({ phase: 'complete', currentLocationCount: 3 }).label).toBe('Current at 3 SharePoint locations');
    expect(pub.publicationEffectLabel('create', { final: true })).toBe('Create SharePoint copy');
    expect(pub.publicationEffectLabel('update_existing', { final: true })).toBe('Update SharePoint version');
    expect(pub.publicationEffectLabel('create', { final: true, place: 'Google Drive' })).toBe('Create Google Drive copy');
    expect(pub.publicationEffectLabel('update_existing', { final: true, place: 'Google Drive' })).toBe('Update Google Drive file');
  });
});

describe('the reader\'s publication drawer', () => {
  it('with Google Drive and no Amazon Employee says Google Drive throughout, and never SharePoint', () => {
    const cases = [
      notPublished,
      { phase: 'pending', completedLocations: [], updateBases: [], attempt: { action: 'create', pendingEditId: 'pe1', publicationStatus: 'pending', effectCertainty: 'none', artifactId: 'art_1', format: 'docx', serverRelativeUrl: 'My Drive/BotBoy/PRD.docx', destination: { provider: 'gdrive' } } },
      { phase: 'approved', completedLocations: [], updateBases: [], attempt: { action: 'create', pendingEditId: 'pe1', docKey: 'gdrive://default/file/x', publicationStatus: 'approved', effectCertainty: 'none', artifactId: 'art_1', format: 'docx', serverRelativeUrl: 'My Drive/BotBoy/PRD.docx', destination: { provider: 'gdrive' } } },
      { phase: 'complete', completedLocations: [driveCopy], updateBases: [], currentLocationCount: 1 },
      { phase: 'update_ready', completedLocations: [{ ...driveCopy, containsSelectedArtifact: false }], updateBases: [{ ...driveCopy, containsSelectedArtifact: false }], currentLocationCount: 0 },
    ];
    for (const view of cases) {
      const html = panel({ amazon: false, drive: true, view });
      expect(html, view.phase).not.toContain('SharePoint');
      expect(html, view.phase).toContain('Google Drive publication');
    }
    expect(panel({ amazon: false, drive: true, view: cases[1] })).toContain('No Google Drive write has occurred for this attempt.');
    expect(panel({ amazon: false, drive: true, view: cases[2] })).toContain('>Create Google Drive copy</button>');
    expect(panel({ amazon: false, drive: true, view: cases[4] })).toContain('Choose the Google Drive file to update');
  });

  it('with only SharePoint keeps its words; with both, the drawer follows the destination picked and the summary stays neutral', () => {
    const sharePointOnly = panel({ amazon: true, drive: false, view: notPublished });
    expect(sharePointOnly).toContain('>SharePoint publication</h3>');
    expect(sharePointOnly).toContain('Reviewing or staging here does not write SharePoint. The final physical-effect button remains separate.');
    expect(sharePointOnly).toContain('Publish to SharePoint…');
    expect(sharePointOnly).not.toContain('Google Drive');
    const both = panel({ amazon: true, drive: true, view: notPublished });
    expect(both).toContain('>Publish…</button>');
    expect(both).toContain('>SharePoint publication</h3>'); // the picker starts on SharePoint
    expect(both).toContain('<option value="sharepoint"');
    expect(panel({ amazon: true, drive: true, view: notPublished, draft: { mode: 'create', provider: 'gdrive', driveChoice: 0 } })).toContain('>Google Drive publication</h3>');
    // A SharePoint attempt says SharePoint even with Amazon Employee off since (its receipt is history).
    const legacy = panel({ amazon: false, drive: true, view: { phase: 'complete', completedLocations: [sharePointCopy], updateBases: [], currentLocationCount: 1 } });
    expect(legacy).toContain('Current on SharePoint');
  });

  it('the reader, the toasts and the project cards take their place from the destination', () => {
    expect(dashboard).toContain('const publicationCopy = publicationPresentation(publicationView, { place: publicationPlace(publicationView, publicationAvailability()) });');
    const decide = topLevel('decideDocumentPublication');
    expect(decide).toContain("toast(provider === 'gdrive'");
    expect(topLevel('applyDocumentPublication')).toContain("'Google Drive copy created and verified.'");
    const project = topLevel('renderProjectDocuments');
    expect(project).toContain('const place = providerPlace(creation.destinationProvider);');
    expect(project).toContain("publicationEffectLabel(isUpdate ? 'update_existing' : 'create', { final: true, place })");
    expect(project).toContain("'Authored BotBoy documents filed to this project appear here.'");
    expect(project.match(/data-provider="\$\{attr\(creation\.destinationProvider \|\| ''\)\}"/g)).toHaveLength(4);
    const server = readFileSync(path.join(process.cwd(), 'src/api/routers/documents.ts'), 'utf8');
    expect(server).toContain('destinationProvider: publication.destinationProvider,');
  });
});

// Owner report 2026-11-16: reviewers had the PRD open; the card said "Publication phase recorded" with only Refresh status.
describe('a publication waiting for its SharePoint file to be closed', () => {
  const now = new Date();
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
  const attempt = {
    action: 'update_existing', pendingEditId: 'pe1', docKey: 'amazon-my.sharepoint.com/personal/u/Documents/PRD.docx', publicationStatus: 'exported',
    pendingStatus: 'approved', effectCertainty: 'none', artifactId: 'art_1', format: 'docx', serverRelativeUrl: '/personal/u/Documents/PRD.docx',
  };
  it('says why, what BotBoy does and until when, that nothing was written, and offers Try now and Stop waiting', () => {
    const html = panel({ amazon: true, drive: false, view: {
      phase: 'waiting_for_file', completedLocations: [sharePointCopy], updateBases: [], currentLocationCount: 0,
      attempt: { ...attempt, lockWait: { tries: 11, startedAt: at(-42), lastTryAt: at(-1), nextTryAt: at(3), endsAt: at(24 * 60 - 42) } },
    } });
    expect(html).toContain('<strong id="document-publication-summary-label">Waiting for the file to close</strong>');
    expect(html).toContain('>Waiting for the file to close</span>');
    expect(html).toContain('Someone has this file open in Word or a browser, so SharePoint refuses changes until everyone closes it (and for up to 10 minutes after). Nothing was written. BotBoy has tried 11 times since ');
    expect(html).toMatch(/; next try at \d{1,2}:\d\d(?:\s?[AP]M)?\. It keeps trying until \w{3} \d{1,2}:\d\d(?:\s?[AP]M)? and tells you in chat how it ends\./);
    expect(html).toContain('No SharePoint write has occurred for this attempt.');
    expect(html).toContain('data-action="documents-publication-sync"');
    expect(html).toContain('>Try now</button>');
    expect(html).toContain('data-action="documents-publication-stop-wait" data-dockey="amazon-my.sharepoint.com/personal/u/Documents/PRD.docx"');
    expect(html).not.toContain('Refresh status');
  });
  it('words a wait whose times are missing without empty gaps', () => {
    const source = [topLevel('lockWaitClock'), topLevel('lockWaitText'), 'return lockWaitText;'].join('\n');
    // eslint-disable-next-line no-new-func
    const text = new Function(source)() as (wait: any) => string;
    expect(text({ retrying: true, attempts: 18 })).toBe('Someone has this file open in Word or a browser, so SharePoint refuses changes until everyone closes it (and for up to 10 minutes after). Nothing was written. BotBoy has tried 18 times. It keeps trying and writes the change once the file is closed.');
  });
  it('after the wait ends without the write, the card says nothing was written and offers the update again', () => {
    const html = panel({ amazon: true, drive: false, view: {
      phase: 'failed', completedLocations: [sharePointCopy], updateBases: [], currentLocationCount: 0,
      attempt: { ...attempt, publicationStatus: 'upload_failed', lastError: 'Not written: you stopped waiting for the file to be closed (11 tries since 18:17). Nothing changed in SharePoint.' },
    } });
    expect(html).toContain('Not written: you stopped waiting for the file to be closed');
    expect(html).toContain('No SharePoint write has occurred for this attempt.');
    expect(html).toContain('>Update SharePoint version</button>');
    // An export never written with no wait open (BotBoy stopped mid-way) is not a dead end either.
    const stranded = panel({ amazon: true, drive: false, view: { phase: 'in_flight', completedLocations: [sharePointCopy], updateBases: [], currentLocationCount: 0, attempt } });
    expect(stranded).toContain('>Update SharePoint version</button>');
    expect(stranded).not.toContain('Refresh status');
  });
});
