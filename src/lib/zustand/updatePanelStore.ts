import {create} from 'zustand';

export interface UpdatePanelData {
  /** e.g. "5.3.0 (2)" */
  newVersion: string;
  /** e.g. "5.2.0" */
  installedVersion: string;
  prerelease: boolean;
  /** Release notes (markdown); shown as plain, trimmed text. */
  notes?: string;
  onUpdate: () => void;
}

interface UpdatePanelState {
  panel?: UpdatePanelData;
  show: (panel: UpdatePanelData) => void;
  dismiss: () => void;
}

const useUpdatePanelStore = create<UpdatePanelState>(set => ({
  panel: undefined,
  show: panel => set({panel}),
  dismiss: () => set({panel: undefined}),
}));

export const showUpdatePanel = (panel: UpdatePanelData) =>
  useUpdatePanelStore.getState().show(panel);

export default useUpdatePanelStore;
