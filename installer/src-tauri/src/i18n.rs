//! Native UI strings (menu, tray, dialogs, user-facing command errors).
//! Kept in Rust so they work in every window, including the remote dashboard
//! wrapper which has no bundled webview i18n.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

const LOCALE_FILE: &str = "locale";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    En,
    It,
}

impl Locale {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "en" => Some(Self::En),
            "it" => Some(Self::It),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::It => "it",
        }
    }

    /// Same heuristic as the webview: `it*` → Italian, otherwise English.
    pub fn from_system() -> Self {
        #[cfg(target_os = "windows")]
        if let Some(locale) = windows_ui_language() {
            return locale;
        }
        for key in ["LANG", "LC_ALL", "LC_MESSAGES", "LANGUAGE"] {
            if let Ok(lang) = std::env::var(key) {
                if lang.to_lowercase().starts_with("it") {
                    return Self::It;
                }
            }
        }
        Self::En
    }
}

#[cfg(target_os = "windows")]
fn windows_ui_language() -> Option<Locale> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserDefaultUILanguage() -> u16;
    }
  // Italian primary language id is 0x10 (it-IT 0x0410, it-CH 0x0810).
    let lang = unsafe { GetUserDefaultUILanguage() };
    if lang & 0x3FF == 0x10 {
        Some(Locale::It)
    } else {
        None
    }
}

/// Keys for native strings. User-facing command errors use the `Error*` variants.
#[derive(Debug, Clone, Copy)]
pub enum Key {
    // Menu / tray
    MenuOpenDashboard,
    MenuConnections,
    MenuSyncNotion,
    MenuCheckUpdates,
    MenuLogout,
    SubmenuConnections,
    MenuFile,
    MenuEdit,
    MenuWindow,
    MenuHelp,
    MenuSettings,
    WindowSettings,
    SettingsButtonLabel,
    SettingsButtonTooltip,
    ErrorBrainNeedsUpdateForSettings,
    TrayOpen,
    TrayQuit,
    CreditsCreatedBy,
    CreditsMaintainersLabel,
    OAuthSuccessTitle,
    OAuthSuccessBody,
    OAuthDeniedTitle,
    OAuthDeniedBody,
    // Dialogs
    LogoutTitle,
    LogoutMessage,
    LogoutConfirm,
    Cancel,
    NotionSyncTitle,
    AppUpdateUpToDateTitle,
    AppUpdateUpToDateMessage,
    AppUpdateCheckFailedTitle,
    AppUpdateCheckFailedMessage,
    AppUpdateAvailableTitle,
    AppUpdateAvailableMessage,
    AppUpdateWhatsNew,
    AppUpdateNow,
    AppUpdateLater,
    AppUpdateFailedTitle,
    AppUpdateFailedMessage,
    WorkerUpdateTitle,
    WorkerUpdateMessage,
    OpenDashboardFailed,
    OpenDashboardNotSetup,
    // Window / injected UI
    WindowSecondBrain,
    WindowConnections,
    ConnectionsButtonLabel,
    ConnectionsButtonTooltip,
    // Command errors
    ErrorBadUrl,
    ErrorEmptyPassword,
    ErrorWrongPassword,
    ErrorNotABrain,
    ErrorCantReach,
    ErrorSetupNotFinished,
    ErrorPasswordTooShort,
    ErrorFriendlyRetry,
    ErrorSecureStoreSetup,
    ErrorSecureStoreConnect,
    ErrorUnknownTool,
    ErrorNoHomeFolder,
    ErrorMcpConfigFailed,
    ErrorCliConfigFailed,
    ErrorInstallInterrupted,
    ErrorClipboardFailed,
    ErrorOpenWindowFailed,
    ErrorCfNoAccount,
    ErrorCfSignInFirst,
    ErrorCfSignInExpired,
    ErrorNotionSynced,
    ErrorNotionUpToDate,
    ErrorCfAccountListFailed,
    ErrorBrainNeedsUpdateForMigration,
    ErrorUnknownEmbeddingModel,
    ErrorMigrationHalfSwitched,
    ErrorCannotDeleteLiveIndex,
    ErrorNoOldIndexToFree,
    ErrorCfNoSubdomain,
    ErrorCfDiscoverFailed,
    ErrorChoosePasswordFirst,
    ErrorLinkNotAllowed,
    ErrorOpenBrowserFailed,
    ErrorReachBrain,
    ErrorComputerNotSetup,
    ErrorCustomDomain,
    ErrorWrongCfAccount,
    ErrorProvisioningDetail,
    ErrorBrainHttpStatus,
    ErrorBrainUnexpected,
    ErrorNotionSyncFailed,
    // Changing the password (#235). Each of these is a {detail} inside a screen
    // the webview owns, never a screen of its own — every failure state in that
    // flow has to carry the new password, which a bare error string cannot do.
    ErrorRotateBlocked,
    ErrorRotateNeedsHttps,
    ErrorRotateNotConfirmed,
    ErrorRotateSecureStore,
}

pub fn t(locale: Locale, key: Key) -> &'static str {
    match (locale, key) {
        // Menu / tray — EN
        (Locale::En, Key::MenuOpenDashboard) => "Open Dashboard",
        (Locale::En, Key::MenuConnections) => "Connections…",
        (Locale::En, Key::MenuSyncNotion) => "Sync Notion now",
        (Locale::En, Key::MenuCheckUpdates) => "Check for updates…",
        (Locale::En, Key::MenuLogout) => "Log out…",
        (Locale::En, Key::SubmenuConnections) => "Connections",
        (Locale::En, Key::MenuFile) => "File",
        (Locale::En, Key::MenuEdit) => "Edit",
        (Locale::En, Key::MenuWindow) => "Window",
        (Locale::En, Key::MenuHelp) => "Help",
        (Locale::En, Key::MenuSettings) => "Advanced Settings…",
        (Locale::En, Key::WindowSettings) => "Advanced Settings",
        (Locale::En, Key::SettingsButtonLabel) => "Advanced Settings",
        (Locale::En, Key::SettingsButtonTooltip) => "Tune how your Second Brain remembers and recalls",
        (Locale::En, Key::ErrorBrainNeedsUpdateForSettings) => {
            "Your Second Brain is running an older version that has no settings yet. \
             Update it from the Connections menu, then reopen this window."
        }
        (Locale::En, Key::TrayOpen) => "Open Second Brain",
        (Locale::En, Key::TrayQuit) => "Quit",
        (Locale::En, Key::CreditsCreatedBy) => "Created by",
        (Locale::En, Key::CreditsMaintainersLabel) => "Maintainers:",
        (Locale::En, Key::OAuthSuccessTitle) => "You&rsquo;re signed in ✓",
        (Locale::En, Key::OAuthSuccessBody) =>
            "You can close this tab and return to the Second Brain app.",
        (Locale::En, Key::OAuthDeniedTitle) => "Sign-in cancelled",
        (Locale::En, Key::OAuthDeniedBody) =>
            "You can close this tab. Head back to the Second Brain app to try again.",
        // Dialogs — EN
        (Locale::En, Key::LogoutTitle) => "Log out",
        (Locale::En, Key::LogoutMessage) => {
            "Log out of this computer?\n\nYour Second Brain and all its memories stay safe. \
             You can reconnect anytime with your address and password."
        }
        (Locale::En, Key::LogoutConfirm) => "Log out",
        (Locale::En, Key::Cancel) => "Cancel",
        (Locale::En, Key::NotionSyncTitle) => "Notion sync",
        (Locale::En, Key::AppUpdateUpToDateTitle) => "You're up to date",
        (Locale::En, Key::AppUpdateUpToDateMessage) => {
            "You have the latest version of Second Brain."
        }
        (Locale::En, Key::AppUpdateCheckFailedTitle) => "Couldn't check for updates",
        (Locale::En, Key::AppUpdateCheckFailedMessage) => {
            "We couldn't check for updates right now. Please try again later."
        }
        (Locale::En, Key::AppUpdateAvailableTitle) => "Update available",
        (Locale::En, Key::AppUpdateAvailableMessage) => {
            "Second Brain {version} is available.\n\nUpdate now? The app will download it and restart."
        }
        (Locale::En, Key::AppUpdateWhatsNew) => "\n\nWhat's new:\n",
        (Locale::En, Key::AppUpdateNow) => "Update now",
        (Locale::En, Key::AppUpdateLater) => "Later",
        (Locale::En, Key::AppUpdateFailedTitle) => "Update didn't finish",
        (Locale::En, Key::AppUpdateFailedMessage) => {
            "Something went wrong installing the update. Your app is unchanged — please try again later."
        }
        (Locale::En, Key::WorkerUpdateTitle) => "Update your Second Brain",
        (Locale::En, Key::WorkerUpdateMessage) => {
            "A newer version of your Second Brain is available (version {version}).\n\n\
             Update now? You'll sign in to Cloudflare once. Your memories, password, \
             and connected tools are kept."
        }
        (Locale::En, Key::OpenDashboardFailed) => "Couldn't open your Second Brain window.",
        (Locale::En, Key::OpenDashboardNotSetup) => "Setup hasn't finished yet.",
        // Window / injected UI — EN
        (Locale::En, Key::WindowSecondBrain) => "Second Brain",
        (Locale::En, Key::WindowConnections) => "Connections",
        (Locale::En, Key::ConnectionsButtonLabel) => "Connections",
        (Locale::En, Key::ConnectionsButtonTooltip) => {
            "Connection details, AI tools, and integrations"
        }
        // Command errors — EN
        (Locale::En, Key::ErrorBadUrl) => {
            "That doesn't look like a web address. It usually ends in .workers.dev."
        }
        (Locale::En, Key::ErrorEmptyPassword) => "Enter the password you chose when you set it up.",
        (Locale::En, Key::ErrorWrongPassword) => {
            "That password doesn't match this Second Brain. Check it and try again."
        }
        (Locale::En, Key::ErrorNotABrain) => {
            "We couldn't find a Second Brain at that address. Double-check the link — it usually ends in .workers.dev."
        }
        (Locale::En, Key::ErrorCantReach) => {
            "We couldn't reach that address. Check it and your internet connection, then try again."
        }
        (Locale::En, Key::ErrorSetupNotFinished) => "Setup hasn't finished yet.",
        (Locale::En, Key::ErrorPasswordTooShort) => "Your password needs at least {min} characters.",
        (Locale::En, Key::ErrorFriendlyRetry) => {
            "That didn't work, but nothing is lost — your progress is saved, so it's safe to try again."
        }
        (Locale::En, Key::ErrorSecureStoreSetup) => {
            "Setup finished, but we couldn't save your details to this device's secure storage."
        }
        (Locale::En, Key::ErrorSecureStoreConnect) => {
            "Connected, but we couldn't save your details to this device's secure storage."
        }
        (Locale::En, Key::ErrorUnknownTool) => "Unknown tool.",
        (Locale::En, Key::ErrorNoHomeFolder) => "Couldn't find your home folder.",
        (Locale::En, Key::ErrorMcpConfigFailed) => {
            "We couldn't update that tool's settings. You can paste the link manually instead."
        }
        (Locale::En, Key::ErrorCliConfigFailed) => {
            "We couldn't write the CLI config. You can run `brain setup` yourself instead."
        }
        (Locale::En, Key::ErrorInstallInterrupted) => "The install was interrupted.",
        (Locale::En, Key::ErrorClipboardFailed) => "Couldn't copy to the clipboard.",
        (Locale::En, Key::ErrorOpenWindowFailed) => "Couldn't open the update window.",
        (Locale::En, Key::ErrorCfNoAccount) => {
            "That Cloudflare login has no account we can set up in."
        }
        (Locale::En, Key::ErrorCfSignInFirst) => "Please sign in to Cloudflare first.",
        (Locale::En, Key::ErrorCfSignInExpired) => {
            "Your Cloudflare sign-in expired. Please sign in again."
        }
        (Locale::En, Key::ErrorNotionSynced) => "Synced {count} change(s) from Notion.",
        (Locale::En, Key::ErrorNotionUpToDate) => "Notion is already up to date.",
        (Locale::En, Key::ErrorCfAccountListFailed) => {
            "Signed in, but we couldn't read your account. Please try again."
        }
        (Locale::En, Key::ErrorMigrationHalfSwitched) => {
            "Your Second Brain has switched to the new way of reading, but finishing the \
switch didn't complete. Your memories are safe and nothing was deleted — reopen this \
window and carry on, or search will stay incomplete."
        }
        (Locale::En, Key::ErrorUnknownEmbeddingModel) => {
            "That isn't a way of reading memories this app knows how to set up."
        }
        (Locale::En, Key::ErrorNoOldIndexToFree) => {
            "There's no leftover search data to free up. Nothing was changed."
        }
        (Locale::En, Key::ErrorCannotDeleteLiveIndex) => {
            "That's the search data your Second Brain is using right now, so it can't be \
freed up. Nothing was changed."
        }
        (Locale::En, Key::ErrorBrainNeedsUpdateForMigration) => {
            "Your Second Brain needs updating before it can change how it reads memories. \
Update it first, then try again."
        }
        (Locale::En, Key::ErrorCfNoSubdomain) => {
            "We couldn't work out the web address for this Cloudflare space, so there's \
nothing to search. You can still enter your Second Brain's address by hand."
        }
        (Locale::En, Key::ErrorCfDiscoverFailed) => {
            "Couldn't look through your Cloudflare space just now. You can enter your \
Second Brain's address by hand instead."
        }
        (Locale::En, Key::ErrorChoosePasswordFirst) => "Please choose a password first.",
        (Locale::En, Key::ErrorLinkNotAllowed) => "That link can't be opened from here.",
        (Locale::En, Key::ErrorOpenBrowserFailed) => "Couldn't open your browser.",
        (Locale::En, Key::ErrorReachBrain) => "Couldn't reach your Second Brain.",
        (Locale::En, Key::ErrorComputerNotSetup) => "This computer isn't set up yet.",
        (Locale::En, Key::ErrorCustomDomain) => {
            "Your Second Brain is on a custom address — update it from your dashboard."
        }
        (Locale::En, Key::ErrorWrongCfAccount) => {
            "That Cloudflare account doesn't host this Second Brain. Sign in with the account you set it up in."
        }
        (Locale::En, Key::ErrorProvisioningDetail) => "What went wrong: {detail}",
        (Locale::En, Key::ErrorBrainHttpStatus) => "Your Second Brain returned {status}.",
        (Locale::En, Key::ErrorBrainUnexpected) => "Unexpected response from your Second Brain.",
        (Locale::En, Key::ErrorNotionSyncFailed) => {
            "The sync didn't finish. Please try again from the dashboard."
        }
        (Locale::En, Key::ErrorRotateBlocked) => {
            "Your Second Brain is rebuilding how it reads your memories, so its password \
can't be changed just now."
        }
        // Deliberately not ErrorBadUrl: `http://my-brain.acme.workers.dev` is a
        // perfectly good address, and telling someone it does not look like one
        // sends them hunting for a typo that is not there.
        (Locale::En, Key::ErrorRotateNeedsHttps) => {
            "Your Second Brain's address has to start with https://. A plain http:// address \
would send your new password unprotected."
        }
        (Locale::En, Key::ErrorRotateNotConfirmed) => {
            "Your Second Brain didn't confirm the new password in time."
        }
        // Not ErrorSecureStoreConnect: that one says "Connected, but…", and
        // nothing was connected here — a working password was replaced.
        (Locale::En, Key::ErrorRotateSecureStore) => {
            "Your password was changed, but we couldn't save it to this device's secure storage."
        }

        // Menu / tray — IT
        (Locale::It, Key::MenuOpenDashboard) => "Apri dashboard",
        (Locale::It, Key::MenuConnections) => "Connessioni…",
        (Locale::It, Key::MenuSyncNotion) => "Sincronizza Notion",
        (Locale::It, Key::MenuCheckUpdates) => "Controlla aggiornamenti…",
        (Locale::It, Key::MenuLogout) => "Esci…",
        (Locale::It, Key::SubmenuConnections) => "Connessioni",
        (Locale::It, Key::MenuFile) => "File",
        (Locale::It, Key::MenuEdit) => "Modifica",
        (Locale::It, Key::MenuWindow) => "Finestra",
        (Locale::It, Key::MenuHelp) => "Aiuto",
        (Locale::It, Key::MenuSettings) => "Impostazioni avanzate…",
        (Locale::It, Key::WindowSettings) => "Impostazioni avanzate",
        (Locale::It, Key::SettingsButtonLabel) => "Impostazioni avanzate",
        (Locale::It, Key::SettingsButtonTooltip) => "Regola come il tuo Second Brain ricorda e recupera",
        (Locale::It, Key::ErrorBrainNeedsUpdateForSettings) => {
            "Il tuo Second Brain usa una versione più vecchia che non ha ancora le impostazioni. \
             Aggiornalo dal menu Connessioni, poi riapri questa finestra."
        }
        (Locale::It, Key::TrayOpen) => "Apri Second Brain",
        (Locale::It, Key::TrayQuit) => "Esci",
        (Locale::It, Key::CreditsCreatedBy) => "Creato da",
        (Locale::It, Key::CreditsMaintainersLabel) => "Manutentori:",
        (Locale::It, Key::OAuthSuccessTitle) => "Accesso effettuato ✓",
        (Locale::It, Key::OAuthSuccessBody) =>
            "Puoi chiudere questa scheda e tornare all’app Second Brain.",
        (Locale::It, Key::OAuthDeniedTitle) => "Accesso annullato",
        (Locale::It, Key::OAuthDeniedBody) =>
            "Puoi chiudere questa scheda. Torna all’app Second Brain per riprovare.",
        // Dialogs — IT
        (Locale::It, Key::LogoutTitle) => "Esci",
        (Locale::It, Key::LogoutMessage) => {
            "Uscire da questo computer?\n\nIl Second Brain e tutte le memorie restano al sicuro. \
             Puoi ricollegarti in qualsiasi momento con indirizzo e password."
        }
        (Locale::It, Key::LogoutConfirm) => "Esci",
        (Locale::It, Key::Cancel) => "Annulla",
        (Locale::It, Key::NotionSyncTitle) => "Sincronizzazione Notion",
        (Locale::It, Key::AppUpdateUpToDateTitle) => "Sei aggiornato",
        (Locale::It, Key::AppUpdateUpToDateMessage) => {
            "Hai l'ultima versione di Second Brain."
        }
        (Locale::It, Key::AppUpdateCheckFailedTitle) => "Impossibile controllare gli aggiornamenti",
        (Locale::It, Key::AppUpdateCheckFailedMessage) => {
            "Non è stato possibile controllare gli aggiornamenti. Riprova più tardi."
        }
        (Locale::It, Key::AppUpdateAvailableTitle) => "Aggiornamento disponibile",
        (Locale::It, Key::AppUpdateAvailableMessage) => {
            "Second Brain {version} è disponibile.\n\nAggiornare ora? L'app scaricherà l'aggiornamento e si riavvierà."
        }
        (Locale::It, Key::AppUpdateWhatsNew) => "\n\nNovità:\n",
        (Locale::It, Key::AppUpdateNow) => "Aggiorna ora",
        (Locale::It, Key::AppUpdateLater) => "Più tardi",
        (Locale::It, Key::AppUpdateFailedTitle) => "Aggiornamento non completato",
        (Locale::It, Key::AppUpdateFailedMessage) => {
            "Qualcosa è andato storto durante l'installazione. L'app non è cambiata — riprova più tardi."
        }
        (Locale::It, Key::WorkerUpdateTitle) => "Aggiorna il Second Brain",
        (Locale::It, Key::WorkerUpdateMessage) => {
            "È disponibile una nuova versione del Second Brain (versione {version}).\n\n\
             Aggiornare ora? Accederai a Cloudflare una volta. Memorie, password e strumenti collegati restano."
        }
        (Locale::It, Key::OpenDashboardFailed) => {
            "Impossibile aprire la finestra del Second Brain."
        }
        (Locale::It, Key::OpenDashboardNotSetup) => "La configurazione non è ancora completata.",
        // Window / injected UI — IT
        (Locale::It, Key::WindowSecondBrain) => "Second Brain",
        (Locale::It, Key::WindowConnections) => "Connessioni",
        (Locale::It, Key::ConnectionsButtonLabel) => "Connessioni",
        (Locale::It, Key::ConnectionsButtonTooltip) => {
            "Dettagli connessione, strumenti AI e integrazioni"
        }
        // Command errors — IT
        (Locale::It, Key::ErrorBadUrl) => {
            "Non sembra un indirizzo web valido. Di solito termina con .workers.dev."
        }
        (Locale::It, Key::ErrorEmptyPassword) => {
            "Inserisci la password scelta durante la configurazione."
        }
        (Locale::It, Key::ErrorWrongPassword) => {
            "La password non corrisponde a questo Second Brain. Controlla e riprova."
        }
        (Locale::It, Key::ErrorNotABrain) => {
            "Non abbiamo trovato un Second Brain a quell'indirizzo. Controlla il link — di solito termina con .workers.dev."
        }
        (Locale::It, Key::ErrorCantReach) => {
            "Impossibile raggiungere quell'indirizzo. Controlla il link e la connessione internet, poi riprova."
        }
        (Locale::It, Key::ErrorSetupNotFinished) => "La configurazione non è ancora completata.",
        (Locale::It, Key::ErrorPasswordTooShort) => {
            "La password deve avere almeno {min} caratteri."
        }
        (Locale::It, Key::ErrorFriendlyRetry) => {
            "Non ha funzionato, ma nulla è perso — i progressi sono salvati, puoi riprovare in sicurezza."
        }
        (Locale::It, Key::ErrorSecureStoreSetup) => {
            "Configurazione completata, ma non è stato possibile salvare i dati nell'archivio sicuro del dispositivo."
        }
        (Locale::It, Key::ErrorSecureStoreConnect) => {
            "Collegato, ma non è stato possibile salvare i dati nell'archivio sicuro del dispositivo."
        }
        (Locale::It, Key::ErrorUnknownTool) => "Strumento sconosciuto.",
        (Locale::It, Key::ErrorNoHomeFolder) => "Impossibile trovare la cartella home.",
        (Locale::It, Key::ErrorMcpConfigFailed) => {
            "Impossibile aggiornare le impostazioni dello strumento. Puoi incollare il link manualmente."
        }
        (Locale::It, Key::ErrorCliConfigFailed) => {
            "Impossibile scrivere la configurazione CLI. Puoi eseguire `brain setup` manualmente."
        }
        (Locale::It, Key::ErrorInstallInterrupted) => "L'installazione è stata interrotta.",
        (Locale::It, Key::ErrorClipboardFailed) => "Impossibile copiare negli appunti.",
        (Locale::It, Key::ErrorOpenWindowFailed) => {
            "Impossibile aprire la finestra di aggiornamento."
        }
        (Locale::It, Key::ErrorCfNoAccount) => {
            "Questo account Cloudflare non ha spazi configurabili."
        }
        (Locale::It, Key::ErrorCfSignInFirst) => "Accedi prima a Cloudflare.",
        (Locale::It, Key::ErrorCfSignInExpired) => {
            "L'accesso a Cloudflare è scaduto. Accedi di nuovo."
        }
        (Locale::It, Key::ErrorNotionSynced) => {
            "Sincronizzate {count} modifiche da Notion."
        }
        (Locale::It, Key::ErrorNotionUpToDate) => "Notion è già aggiornato.",
        (Locale::It, Key::ErrorCfAccountListFailed) => {
            "Accesso effettuato, ma non è stato possibile leggere l'account. Riprova."
        }
        (Locale::It, Key::ErrorMigrationHalfSwitched) => {
            "Il tuo Second Brain è passato al nuovo modo di leggere, ma il passaggio non è \
stato completato. I tuoi ricordi sono al sicuro e nulla è stato cancellato — riapri questa \
finestra e continua, altrimenti la ricerca resterà incompleta."
        }
        (Locale::It, Key::ErrorUnknownEmbeddingModel) => {
            "Non è un modo di leggere i ricordi che questa app sappia configurare."
        }
        (Locale::It, Key::ErrorNoOldIndexToFree) => {
            "Non ci sono vecchi dati di ricerca da liberare. Nulla è stato modificato."
        }
        (Locale::It, Key::ErrorCannotDeleteLiveIndex) => {
            "Sono i dati di ricerca che il tuo Second Brain sta usando in questo momento, \
quindi non possono essere liberati. Nulla è stato modificato."
        }
        (Locale::It, Key::ErrorBrainNeedsUpdateForMigration) => {
            "Il tuo Second Brain va aggiornato prima di poter cambiare il modo in cui legge \
i ricordi. Aggiornalo, poi riprova."
        }
        (Locale::It, Key::ErrorCfNoSubdomain) => {
            "Non siamo riusciti a determinare l'indirizzo web di questo spazio Cloudflare, \
quindi non c'è nulla da cercare. Puoi comunque inserire a mano l'indirizzo del tuo Second Brain."
        }
        (Locale::It, Key::ErrorCfDiscoverFailed) => {
            "Non è stato possibile esaminare il tuo spazio Cloudflare in questo momento. \
Puoi inserire a mano l'indirizzo del tuo Second Brain."
        }
        (Locale::It, Key::ErrorChoosePasswordFirst) => "Scegli prima una password.",
        (Locale::It, Key::ErrorLinkNotAllowed) => "Questo link non può essere aperto da qui.",
        (Locale::It, Key::ErrorOpenBrowserFailed) => "Impossibile aprire il browser.",
        (Locale::It, Key::ErrorReachBrain) => "Impossibile raggiungere il Second Brain.",
        (Locale::It, Key::ErrorComputerNotSetup) => "Questo computer non è ancora configurato.",
        (Locale::It, Key::ErrorCustomDomain) => {
            "Il Second Brain è su un indirizzo personalizzato — aggiornalo dalla dashboard."
        }
        (Locale::It, Key::ErrorWrongCfAccount) => {
            "Questo account Cloudflare non ospita questo Second Brain. Accedi con l'account usato per la configurazione."
        }
        (Locale::It, Key::ErrorProvisioningDetail) => "Cosa è andato storto: {detail}",
        (Locale::It, Key::ErrorBrainHttpStatus) => "Il Second Brain ha risposto con {status}.",
        (Locale::It, Key::ErrorBrainUnexpected) => "Risposta inattesa dal Second Brain.",
        (Locale::It, Key::ErrorNotionSyncFailed) => {
            "La sincronizzazione non è terminata. Riprova dalla dashboard."
        }
        (Locale::It, Key::ErrorRotateBlocked) => {
            "Il tuo Second Brain sta ricostruendo il modo in cui legge i tuoi ricordi, \
quindi la sua password non può essere cambiata adesso."
        }
        (Locale::It, Key::ErrorRotateNeedsHttps) => {
            "L'indirizzo del tuo Second Brain deve iniziare con https://. Un indirizzo http:// \
invierebbe la tua nuova password senza protezione."
        }
        (Locale::It, Key::ErrorRotateNotConfirmed) => {
            "Il tuo Second Brain non ha confermato la nuova password in tempo."
        }
        (Locale::It, Key::ErrorRotateSecureStore) => {
            "La password è stata cambiata, ma non è stato possibile salvarla nell'archivio \
sicuro del dispositivo."
        }
    }
}

/// Replace `{name}` placeholders in a translated string.
pub fn t_fmt(locale: Locale, key: Key, params: &[(&str, &str)]) -> String {
    let mut s = t(locale, key).to_string();
    for (name, value) in params {
        s = s.replace(&format!("{{{name}}}"), value);
    }
    s
}

// ── Locale persistence & app state ───────────────────────────────────────────

/// Current UI locale, shared across commands and native UI.
pub struct AppLocale(pub Mutex<Locale>);

impl AppLocale {
    pub fn new(locale: Locale) -> Self {
        Self(Mutex::new(locale))
    }

    pub fn get(&self) -> Locale {
        *self.0.lock().unwrap()
    }

    pub fn set(&self, locale: Locale) {
        *self.0.lock().unwrap() = locale;
    }
}

pub fn locale_file_path(config_dir: &Path) -> PathBuf {
    config_dir.join(LOCALE_FILE)
}

pub fn read_stored_locale(config_dir: &Path) -> Option<Locale> {
    let content = std::fs::read_to_string(locale_file_path(config_dir)).ok()?;
    Locale::parse(content.trim())
}

pub fn write_stored_locale(config_dir: &Path, locale: Locale) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    std::fs::write(locale_file_path(config_dir), locale.as_str())
}

pub fn resolve_initial_locale(config_dir: Option<&Path>) -> Locale {
    if let Some(dir) = config_dir {
        if let Some(locale) = read_stored_locale(dir) {
            return locale;
        }
    }
    Locale::from_system()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_keys() -> &'static [Key] {
        use Key::*;
        &[
            MenuOpenDashboard,
            MenuConnections,
            MenuSyncNotion,
            MenuCheckUpdates,
            MenuLogout,
            SubmenuConnections,
            MenuFile,
            MenuEdit,
            MenuWindow,
            MenuHelp,
            MenuSettings,
            WindowSettings,
            SettingsButtonLabel,
            SettingsButtonTooltip,
            ErrorBrainNeedsUpdateForSettings,
            TrayOpen,
            TrayQuit,
            CreditsCreatedBy,
            CreditsMaintainersLabel,
            OAuthSuccessTitle,
            OAuthSuccessBody,
            OAuthDeniedTitle,
            OAuthDeniedBody,
            LogoutTitle,
            LogoutMessage,
            LogoutConfirm,
            Cancel,
            NotionSyncTitle,
            AppUpdateUpToDateTitle,
            AppUpdateUpToDateMessage,
            AppUpdateCheckFailedTitle,
            AppUpdateCheckFailedMessage,
            AppUpdateAvailableTitle,
            AppUpdateAvailableMessage,
            AppUpdateWhatsNew,
            AppUpdateNow,
            AppUpdateLater,
            AppUpdateFailedTitle,
            AppUpdateFailedMessage,
            WorkerUpdateTitle,
            WorkerUpdateMessage,
            OpenDashboardFailed,
            OpenDashboardNotSetup,
            WindowSecondBrain,
            WindowConnections,
            ConnectionsButtonLabel,
            ConnectionsButtonTooltip,
            ErrorBadUrl,
            ErrorEmptyPassword,
            ErrorWrongPassword,
            ErrorNotABrain,
            ErrorCantReach,
            ErrorSetupNotFinished,
            ErrorPasswordTooShort,
            ErrorFriendlyRetry,
            ErrorSecureStoreSetup,
            ErrorSecureStoreConnect,
            ErrorUnknownTool,
            ErrorNoHomeFolder,
            ErrorMcpConfigFailed,
            ErrorCliConfigFailed,
            ErrorInstallInterrupted,
            ErrorClipboardFailed,
            ErrorOpenWindowFailed,
            ErrorCfNoAccount,
            ErrorCfSignInFirst,
            ErrorCfSignInExpired,
            ErrorBrainNeedsUpdateForMigration,
            ErrorUnknownEmbeddingModel,
            ErrorMigrationHalfSwitched,
            ErrorCannotDeleteLiveIndex,
            ErrorNoOldIndexToFree,
            ErrorCfNoSubdomain,
            ErrorCfDiscoverFailed,
            ErrorNotionSynced,
            ErrorNotionUpToDate,
            ErrorCfAccountListFailed,
            ErrorChoosePasswordFirst,
            ErrorLinkNotAllowed,
            ErrorOpenBrowserFailed,
            ErrorReachBrain,
            ErrorComputerNotSetup,
            ErrorCustomDomain,
            ErrorWrongCfAccount,
            ErrorProvisioningDetail,
            ErrorBrainHttpStatus,
            ErrorBrainUnexpected,
            ErrorNotionSyncFailed,
            ErrorRotateBlocked,
            ErrorRotateNeedsHttps,
            ErrorRotateNotConfirmed,
            ErrorRotateSecureStore,
        ]
    }

    #[test]
    fn parse_locale() {
        assert_eq!(Locale::parse("en"), Some(Locale::En));
        assert_eq!(Locale::parse("IT"), Some(Locale::It));
        assert_eq!(Locale::parse("fr"), None);
    }

    #[test]
    fn italian_menu_strings() {
        assert_eq!(t(Locale::It, Key::MenuOpenDashboard), "Apri dashboard");
        assert_eq!(t(Locale::It, Key::SubmenuConnections), "Connessioni");
    }

    #[test]
    fn t_fmt_replaces_placeholders() {
        let s = t_fmt(Locale::En, Key::ErrorPasswordTooShort, &[("min", "12")]);
        assert!(s.contains("12"));
        let s = t_fmt(Locale::It, Key::WorkerUpdateMessage, &[("version", "1.2.3")]);
        assert!(s.contains("1.2.3"));
    }

    #[test]
    fn locale_file_roundtrip() {
        let dir = std::env::temp_dir().join(format!("sb-locale-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_stored_locale(&dir, Locale::It).unwrap();
        assert_eq!(read_stored_locale(&dir), Some(Locale::It));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_initial_locale_prefers_stored_over_system() {
        let dir = std::env::temp_dir().join(format!("sb-locale-resolve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_stored_locale(&dir, Locale::It).unwrap();
        assert_eq!(resolve_initial_locale(Some(&dir)), Locale::It);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_initial_locale_falls_back_without_stored_file() {
        let dir = std::env::temp_dir().join(format!("sb-locale-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // No locale file → same result as from_system().
        assert_eq!(resolve_initial_locale(Some(&dir)), Locale::from_system());
        assert_eq!(resolve_initial_locale(None), Locale::from_system());
    }

    #[test]
    fn every_key_has_non_empty_en_and_it_string() {
        for &key in all_keys() {
            let en = t(Locale::En, key);
            let it = t(Locale::It, key);
            assert!(!en.is_empty(), "empty EN string for {key:?}");
            assert!(!it.is_empty(), "empty IT string for {key:?}");
        }
    }
}
