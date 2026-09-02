use flate2::{write::GzEncoder, Compression};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use tar::{Builder, Header};

const DEFAULT_EXCLUSIONS: &[&str] = &[".git", ".venv", "node_modules", "target", "assets/.tmp"];

/// Build deterministic gzip-compressed USTAR archive from workspace contents.
/// Entries use stable ordering and metadata; symlinks are rejected to prevent
/// archive traversal and remote deployment outside the workspace root.
pub fn create_workspace_archive(root: impl AsRef<Path>) -> io::Result<Vec<u8>> {
    let root = fs::canonicalize(root)?;
    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut builder = Builder::new(encoder);
    let mut entries = Vec::new();
    collect_entries(&root, &root, &mut entries)?;
    entries.sort();
    for relative in entries {
        let source = root.join(&relative);
        let metadata = fs::symlink_metadata(&source)?;
        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("symlink is not allowed in archive: {}", relative.display()),
            ));
        }
        let name = relative.to_string_lossy().replace('\\', "/");
        if metadata.is_dir() {
            let mut header = Header::new_ustar();
            header.set_entry_type(tar::EntryType::Directory);
            header.set_mode(0o755);
            header.set_uid(0);
            header.set_gid(0);
            header.set_mtime(0);
            header.set_size(0);
            header.set_cksum();
            builder.append_data(&mut header, format!("{name}/"), io::empty())?;
        } else if metadata.is_file() {
            let mut file = fs::File::open(&source)?;
            let mut header = Header::new_ustar();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_mode(0o644);
            header.set_uid(0);
            header.set_gid(0);
            header.set_mtime(0);
            header.set_size(metadata.len());
            header.set_cksum();
            builder.append_data(&mut header, name, &mut file)?;
        }
    }
    let encoder = builder.into_inner()?;
    encoder.finish()
}

fn collect_entries(root: &Path, current: &Path, output: &mut Vec<PathBuf>) -> io::Result<()> {
    let mut children = fs::read_dir(current)?.collect::<Result<Vec<_>, io::Error>>()?;
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        let path = child.path();
        let relative = path
            .strip_prefix(root)
            .map_err(io::Error::other)?
            .to_path_buf();
        validate_relative(&relative)?;
        if is_excluded(&relative) {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("symlink is not allowed in archive: {}", relative.display()),
            ));
        }
        output.push(relative);
        if metadata.is_dir() {
            collect_entries(root, &path, output)?;
        }
    }
    Ok(())
}

fn is_excluded(relative: &Path) -> bool {
    let normalized = relative.to_string_lossy().replace('\\', "/");
    DEFAULT_EXCLUSIONS
        .iter()
        .any(|excluded| normalized == *excluded || normalized.starts_with(&format!("{excluded}/")))
}

fn validate_relative(path: &Path) -> io::Result<()> {
    if path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::RootDir))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("path escapes workspace: {}", path.display()),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use uuid::Uuid;

    #[test]
    fn archive_is_sorted_deterministic_and_excludes_runtime_dirs() {
        let root = std::env::temp_dir().join(format!("dartsnut-archive-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("z.txt"), b"z").unwrap();
        fs::write(root.join("src/a.txt"), b"a").unwrap();
        fs::write(root.join("node_modules/ignored"), b"x").unwrap();
        let first = create_workspace_archive(&root).unwrap();
        let second = create_workspace_archive(&root).unwrap();
        assert_eq!(first, second);
        let decoder = flate2::read::GzDecoder::new(Cursor::new(first));
        let mut archive = tar::Archive::new(decoder);
        let names = archive
            .entries()
            .unwrap()
            .map(|entry| {
                entry
                    .unwrap()
                    .path()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["src/", "src/a.txt", "z.txt"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("dartsnut-archive-link-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        symlink("/tmp", root.join("escape")).unwrap();
        let error = create_workspace_archive(&root).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        fs::remove_dir_all(root).unwrap();
    }
}
