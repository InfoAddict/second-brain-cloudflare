//! Project credits for the native About dialog and in-app About section.
//! Human contributors from git history; bots and automated agents are excluded.

pub struct Person {
    pub name: &'static str,
    pub github: Option<&'static str>,
}

/// Original author of Second Brain.
pub const CREATOR: Person = Person {
    name: "Rahil Pirani",
    github: Some("rahilp"),
};

/// Everyone with commits in this repository except bots / AI automation accounts.
pub const MAINTAINERS: &[Person] = &[
    Person {
        name: "Vincenzo Fabiano",
        github: None,
    },
    Person {
        name: "Aneesh Grover",
        github: Some("Aneesh-382005"),
    },
    Person {
        name: "Mike Stanley",
        github: Some("mikestanley00"),
    },
    Person {
        name: "Mochammad Fadhlan Al-Ghiffari",
        github: Some("MFA-G"),
    },
    Person {
        name: "Phillip Smith",
        github: Some("phillipadsmith"),
    },
    Person {
        name: "Robert Brandin",
        github: Some("tumes"),
    },
];

fn line(person: &Person) -> String {
    match person.github {
        Some(handle) => format!("{} (@{handle})", person.name),
        None => person.name.to_string(),
    }
}

/// macOS About panel — multiline credits field.
pub fn credits_text() -> String {
    let mut out = format!("Created by {}\n\nMaintainers:\n", line(&CREATOR));
    for person in MAINTAINERS {
        out.push_str(&format!("• {}\n", line(person)));
    }
    out.trim_end().to_string()
}

/// Windows / Linux About — author list (creator first, then maintainers).
pub fn author_names() -> Vec<String> {
    let mut names = vec![line(&CREATOR)];
    names.extend(MAINTAINERS.iter().map(line));
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credits_include_creator_and_maintainers() {
        let text = credits_text();
        assert!(text.contains("Rahil Pirani"));
        assert!(text.contains("Vincenzo Fabiano"));
        assert!(!text.contains("dependabot"));
        assert!(!text.contains("bot]"));
    }

    #[test]
    fn authors_list_starts_with_creator() {
        let authors = author_names();
        assert!(authors[0].contains("Rahil"));
        assert_eq!(authors.len(), 1 + MAINTAINERS.len());
    }
}
