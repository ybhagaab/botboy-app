export function beginProjectArtifactLoad(current = {}) {
  return {
    artifacts: current.artifacts ?? null,
    unassigned: current.unassigned ?? null,
    attachOpen: current.attachOpen ?? false,
    unassignedLoading: current.unassignedLoading ?? false,
    unassignedError: current.unassignedError ?? '',
    ...current,
    loading: true,
    error: '',
  };
}

export function completeProjectArtifactLoad(current = {}, artifacts = []) {
  return { ...current, artifacts, loading: false, error: '' };
}

export function failProjectArtifactLoad(current = {}, error = '') {
  return { ...current, artifacts: current.artifacts ?? null, loading: false, error: String(error) };
}

export function beginUnassignedArtifactLoad(current = {}) {
  return { ...current, attachOpen: true, unassignedLoading: true, unassignedError: '' };
}

export function completeUnassignedArtifactLoad(current = {}, unassigned = []) {
  return { ...current, attachOpen: true, unassigned, unassignedLoading: false, unassignedError: '' };
}

export function failUnassignedArtifactLoad(current = {}, error = '') {
  return { ...current, attachOpen: true, unassignedLoading: false, unassignedError: String(error) };
}
