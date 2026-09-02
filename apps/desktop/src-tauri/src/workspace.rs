use std::io;
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("workspace path does not exist: {0}")]
    Missing(PathBuf),
    #[error("workspace path is not a directory: {0}")]
    NotDirectory(PathBuf),
    #[error("path escapes workspace root")]
    Escape,
    #[error("workspace I/O error: {0}")]
    Io(#[from] io::Error),
}

#[derive(Clone, Debug)]
pub struct WorkspaceRoot(PathBuf);

impl WorkspaceRoot {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, WorkspaceError> {
        let path = path.as_ref();
        if !path.exists() {
            return Err(WorkspaceError::Missing(path.to_path_buf()));
        }
        if !path.is_dir() {
            return Err(WorkspaceError::NotDirectory(path.to_path_buf()));
        }
        Ok(Self(std::fs::canonicalize(path)?))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn resolve(&self, relative: impl AsRef<Path>) -> Result<PathBuf, WorkspaceError> {
        let relative = relative.as_ref();
        if relative.is_absolute() {
            return Err(WorkspaceError::Escape);
        }
        let candidate = self.0.join(relative);
        let parent = candidate.parent().unwrap_or(self.0.as_path());
        let canonical_parent =
            std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
        if !canonical_parent.starts_with(&self.0) {
            return Err(WorkspaceError::Escape);
        }
        if candidate.exists() {
            let canonical = std::fs::canonicalize(&candidate)?;
            if !canonical.starts_with(&self.0) {
                return Err(WorkspaceError::Escape);
            }
            return Ok(canonical);
        }
        Ok(candidate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_absolute_and_parent_escape() {
        let root = tempfile_dir();
        let workspace = WorkspaceRoot::open(&root).unwrap();
        assert!(matches!(
            workspace.resolve("/tmp"),
            Err(WorkspaceError::Escape)
        ));
        assert!(matches!(
            workspace.resolve("../outside"),
            Err(WorkspaceError::Escape)
        ));
    }

    #[test]
    fn resolves_existing_file_inside_root() {
        let root = tempfile_dir();
        fs::write(root.join("ok.txt"), "ok").unwrap();
        let workspace = WorkspaceRoot::open(&root).unwrap();
        assert!(workspace
            .resolve("ok.txt")
            .unwrap()
            .starts_with(workspace.path()));
    }

    fn tempfile_dir() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("dartsnut-workspace-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }
}
