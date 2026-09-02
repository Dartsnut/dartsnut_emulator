use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub folder_path: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_opened_at: String,
    #[serde(default)]
    pub migration_complete: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatRecord {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub archived_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoreFile {
    schema_version: u32,
    projects: Vec<ProjectRecord>,
    chats: Vec<ChatRecord>,
    #[serde(default)]
    last_opened_chat_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ProjectStore {
    root: PathBuf,
    file: PathBuf,
    data: StoreFile,
}

impl ProjectStore {
    pub fn open(user_data: impl AsRef<Path>) -> io::Result<Self> {
        let root = user_data.as_ref().join("projects");
        let file = root.join("projects.json");
        let data = match fs::read_to_string(&file) {
            Ok(body) => serde_json::from_str(&body).unwrap_or_else(|_| empty_store()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => empty_store(),
            Err(error) => return Err(error),
        };
        Ok(Self { root, file, data })
    }

    pub fn list(&self) -> (Vec<ProjectRecord>, Vec<ChatRecord>) {
        let mut projects = self.data.projects.clone();
        projects.sort_by(|a, b| b.last_opened_at.cmp(&a.last_opened_at));
        let chats = self
            .data
            .chats
            .iter()
            .filter(|chat| chat.archived_at.is_none())
            .cloned()
            .collect();
        (projects, chats)
    }

    pub fn project(&self, project_id: &str) -> Option<ProjectRecord> {
        self.data
            .projects
            .iter()
            .find(|project| project.id == project_id)
            .cloned()
    }

    pub fn chat(&self, chat_id: &str) -> Option<ChatRecord> {
        self.data
            .chats
            .iter()
            .find(|chat| chat.id == chat_id)
            .cloned()
    }

    pub fn ensure_project(
        &mut self,
        folder_path: impl AsRef<Path>,
        name: Option<&str>,
    ) -> io::Result<ProjectRecord> {
        let folder = fs::canonicalize(folder_path.as_ref())
            .unwrap_or_else(|_| folder_path.as_ref().to_path_buf());
        if let Some(project) = self
            .data
            .projects
            .iter()
            .find(|project| Path::new(&project.folder_path) == folder)
        {
            return Ok(project.clone());
        }
        let stamp = now();
        let project = ProjectRecord {
            id: Uuid::new_v4().to_string(),
            name: name
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| {
                    folder
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or("Project")
                })
                .to_owned(),
            folder_path: folder.to_string_lossy().into_owned(),
            created_at: stamp.clone(),
            updated_at: stamp.clone(),
            last_opened_at: stamp,
            migration_complete: false,
        };
        self.data.projects.push(project.clone());
        self.save()?;
        Ok(project)
    }

    pub fn create_chat(&mut self, project_id: &str, title: Option<&str>) -> io::Result<ChatRecord> {
        if !self
            .data
            .projects
            .iter()
            .any(|project| project.id == project_id)
        {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "project does not exist",
            ));
        }
        let stamp = now();
        let chat = ChatRecord {
            id: Uuid::new_v4().to_string(),
            project_id: project_id.to_owned(),
            title: title
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("New chat")
                .to_owned(),
            created_at: stamp.clone(),
            updated_at: stamp,
            archived_at: None,
        };
        self.data.chats.push(chat.clone());
        self.save()?;
        Ok(chat)
    }

    pub fn remove_project(&mut self, project_id: &str) -> io::Result<bool> {
        let existed = self
            .data
            .projects
            .iter()
            .any(|project| project.id == project_id);
        if !existed {
            return Ok(false);
        }
        self.data
            .projects
            .retain(|project| project.id != project_id);
        self.data.chats.retain(|chat| chat.project_id != project_id);
        if self
            .data
            .last_opened_chat_id
            .as_deref()
            .is_some_and(|_chat| {
                !self
                    .data
                    .chats
                    .iter()
                    .any(|item| Some(item.id.as_str()) == self.data.last_opened_chat_id.as_deref())
            })
        {
            self.data.last_opened_chat_id = None;
        }
        self.save()?;
        Ok(true)
    }

    pub fn archive_chat(&mut self, chat_id: &str) -> io::Result<bool> {
        let Some(chat) = self.data.chats.iter_mut().find(|chat| chat.id == chat_id) else {
            return Ok(false);
        };
        if chat.archived_at.is_none() {
            chat.archived_at = Some(now());
            chat.updated_at = now();
        }
        if self.data.last_opened_chat_id.as_deref() == Some(chat_id) {
            self.data.last_opened_chat_id = None;
        }
        self.save()?;
        Ok(true)
    }

    pub fn rename_chat(&mut self, chat_id: &str, title: &str) -> io::Result<bool> {
        let title = title.trim();
        if title.is_empty() {
            return Ok(false);
        }
        let Some(chat) = self.data.chats.iter_mut().find(|chat| chat.id == chat_id) else {
            return Ok(false);
        };
        chat.title = title.chars().take(120).collect();
        chat.updated_at = now();
        self.save()?;
        Ok(true)
    }

    fn save(&self) -> io::Result<()> {
        let body = serde_json::to_string_pretty(&self.data).map_err(io::Error::other)? + "\n";
        fs::create_dir_all(&self.root)?;
        let tmp = self.file.with_extension(format!("{}.tmp", Uuid::new_v4()));
        fs::write(&tmp, body)?;
        fs::rename(tmp, &self.file)
    }
}

fn empty_store() -> StoreFile {
    StoreFile {
        schema_version: 1,
        projects: Vec::new(),
        chats: Vec::new(),
        last_opened_chat_id: None,
    }
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_reloads_project_store_atomically() {
        let root = std::env::temp_dir().join(format!("dartsnut-projects-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let mut store = ProjectStore::open(&root).unwrap();
        let created = store.ensure_project(&workspace, Some("Demo")).unwrap();
        let reloaded = ProjectStore::open(&root).unwrap();
        let (projects, chats) = reloaded.list();
        assert_eq!(projects, vec![created]);
        assert!(chats.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn renames_chat_and_persists_title() {
        let root = std::env::temp_dir().join(format!("dartsnut-projects-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let workspace = root.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let mut store = ProjectStore::open(&root).unwrap();
        let project = store.ensure_project(&workspace, None).unwrap();
        let chat = store.create_chat(&project.id, None).unwrap();
        assert!(store.rename_chat(&chat.id, "  Build widget  ").unwrap());
        let (_, chats) = ProjectStore::open(&root).unwrap().list();
        assert_eq!(chats[0].title, "Build widget");
        fs::remove_dir_all(root).unwrap();
    }
}
