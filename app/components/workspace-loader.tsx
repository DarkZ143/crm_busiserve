export function WorkspaceLoader() {
  return (
    <div className="page-loading" role="status" aria-label="Loading workspace">
      <div className="workspace-hand-loader" aria-hidden="true">
        <div className="workspace-hand-finger" />
        <div className="workspace-hand-finger" />
        <div className="workspace-hand-finger" />
        <div className="workspace-hand-finger" />
        <div className="workspace-hand-palm" />
        <div className="workspace-hand-thumb" />
      </div>
    </div>
  );
}
