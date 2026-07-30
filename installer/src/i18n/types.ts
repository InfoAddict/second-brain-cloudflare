export type Locale = "en" | "it";

/** One named level of a multi-value control (#246). */
export type LevelCopy = {
  name: string;
  /** Names the downside as well as the upside — see #244 copy conventions. */
  notice: string;
};

export type Messages = {
  common: {
    continue: string;
    back: string;
    copy: string;
    copied: string;
    copyBoth: string;
    copyLink: string;
    copyAddress: string;
    copyCommand: string;
    connect: string;
    connecting: string;
    connected: string;
    openSettings: string;
    emailDetails: string;
    notNow: string;
    tryAgain: string;
    checking: string;
    ready: string;
    notFound: string;
    demoMode: string;
    appTitle: string;
  };
  settings: {
    title: string;
    language: string;
    languageDesc: string;
    english: string;
    italian: string;
  };
  settingsPanel: {
    title: string;
    lede: string;
    sectionRecall: string;
    sectionRemember: string;
    sectionAi: string;
    custom: string;
    customNote: string;
    reset: string;
    save: string;
    cancel: string;
    unsaved: string;
    unsavedOne: string;
    saving: string;
    saved: string;
    loadFailed: string;
    recency: { label: string; desc: string; levels: { timeless: LevelCopy; balanced: LevelCopy; recent_first: LevelCopy } };
    variety: { label: string; desc: string; levels: { focused: LevelCopy; balanced: LevelCopy; varied: LevelCopy } };
    connections: { label: string; desc: string; levels: { off: LevelCopy; nearby: LevelCopy; extended: LevelCopy } };
    detail: { label: string; desc: string; levels: { compact: LevelCopy; standard: LevelCopy; full: LevelCopy } };
    duplicates: { label: string; desc: string; note: string; levels: { permissive: LevelCopy; standard: LevelCopy; strict: LevelCopy } };
    compression: { label: string; desc: string; note: string; levels: { conservative: LevelCopy; standard: LevelCopy; aggressive: LevelCopy } };
    model: { label: string; desc: string; sizeNote: string; neuronsNote: string };
  };
  welcome: {
    title: string;
    lede: string;
    getStarted: string;
    alreadyHave: string;
    footnote: string;
  };
  connectExisting: {
    title: string;
    lede: string;
    addressPlaceholder: string;
    passwordPlaceholder: string;
    connect: string;
    footnote: string;
  };
  password: {
    title: string;
    lede: string;
    placeholder: string;
    confirmPlaceholder: string;
    generateTitle: string;
    tooShort: string;
    checking: string;
    foundInBreaches: string;
    strong: string;
    good: string;
    easyToGuess: string;
    breachHint: string;
    mismatch: string;
    notice: string;
    footnote: string;
  };
  cloudflare: {
    title: string;
    lede: string;
    signIn: string;
    footnote: string;
    waitingTitle: string;
    waitingLede: string;
    watchingSignIn: string;
    pickerTitle: string;
    pickerLede: string;
  };
  progress: {
    title: string;
    lede: string;
    stepSpace: string;
    stepMemory: string;
    stepRecall: string;
    stepFinish: string;
  };
  tools: {
    title: string;
    lede: string;
    autoSetup: string;
    notOnComputer: string;
    doneRestart: string;
    cliSub: string;
    setupCli: string;
    settingUp: string;
    cliDone: string;
    installing: string;
    installed: string;
    reopenTerminal: string;
    configSaved: string;
    configSavedInstallFailed: string;
    configSavedNoNpm: string;
    pasteInSettings: string;
    claudeCode: string;
    cursor: string;
    cliTitle: string;
    chatgpt: string;
    claudeWeb: string;
  };
  details: {
    title: string;
    lede: string;
    notSetupTitle: string;
    notSetupLede: string;
    addressLabel: string;
    addressDesc: string;
    mcpLabel: string;
    mcpDesc: string;
    connectToolsTitle: string;
    connectToolsDesc: string;
    integrationsTitle: string;
    integrationsDesc: string;
    navConnection: string;
    navTools: string;
    navIntegrations: string;
    navComputer: string;
    updateLabel: string;
    updateDesc: string;
    updateButton: string;
    allSetTitle: string;
    allSetLede: string;
    openDashboard: string;
  };
  integrations: {
    extensionTitle: string;
    extensionSub: string;
    getExtension: string;
    obsidianTitle: string;
    obsidianSub: string;
    openObsidian: string;
    getPlugin: string;
    connectedPlain: string;
    connectedTo: string;
    syncNow: string;
    syncing: string;
    manage: string;
    setUp: string;
    appsTitle: string;
    back: string;
    categoryKnowledge: string;
    categoryCalendar: string;
    categoryEmail: string;
    categoryOther: string;
  };
  logout: {
    button: string;
    confirm: string;
    keep: string;
    desc: string;
  };
  workerUpdate: {
    title: string;
    ledeWithVersion: string;
    ledeGeneric: string;
    notice: string;
    signInUpdate: string;
    waitingLede: string;
    updatingTitle: string;
    updatingLede: string;
    stepMemory: string;
    stepRecall: string;
    stepFinish: string;
    doneTitle: string;
    doneLede: string;
  };
  email: {
    subject: string;
    bodyAddress: string;
    bodyMcp: string;
  };
};
