import { describe, expect, it } from 'vitest';
import {
  decodeSharePointPath,
  personalDocumentsRoot,
  resolvePublicationDestinationCandidates,
} from './publication-destination-default.js';

describe('publication destination default resolution', () => {
  it('extracts an exact personal Documents root and decodes MCP-v2 Unicode once', () => {
    expect(personalDocumentsRoot('/personal/user_amazon_com/Documents/Plans/Strategy.docx'))
      .toBe('/personal/user_amazon_com/Documents');
    expect(decodeSharePointPath('/personal/user/Documents/MX%20PMT%20%C3%97%20PVAA.docx'))
      .toBe('/personal/user/Documents/MX PMT × PVAA.docx');
  });

  it('rejects team sites, malformed encoding, and non-path identity guesses', () => {
    expect(personalDocumentsRoot('/sites/team/Shared Documents/Strategy.docx')).toBeNull();
    expect(personalDocumentsRoot('/personal/user/Documents%ZZ/file.docx')).toBeNull();
    expect(personalDocumentsRoot('user@amazon.com')).toBeNull();
  });

  it('requires one unambiguous exact root', () => {
    expect(resolvePublicationDestinationCandidates([
      '/personal/u/Documents/a.docx', '/personal/u/Documents/folder/b.docx',
    ], 'sharepoint_list_files')).toMatchObject({
      status: 'resolved', targetFolder: '/personal/u/Documents', source: 'sharepoint_list_files',
    });
    expect(resolvePublicationDestinationCandidates([
      '/personal/u/Documents/a.docx', '/personal/other/Documents/b.docx',
    ], 'sharepoint_list_files')).toMatchObject({ status: 'ambiguous', targetFolder: null });
  });
});
