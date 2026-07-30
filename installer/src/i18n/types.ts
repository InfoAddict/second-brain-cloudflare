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
    sectionMatching: string;
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
    /**
     * Rebuilding how memories are read (#248). The only destructive, multi-step
     * flow in this window, so it carries a screen's worth of copy per step
     * rather than one notice per level.
     */
    migration: {
      lede: string;
      label: string;
      desc: string;
      /** Three forms: "1 memory saved" is the count a real new brain shows. */
      entries: string;
      entriesOne: string;
      entriesNone: string;
      pickLabel: string;
      inUse: string;
      storageWarning: string;
      pickNote: string;
      /**
       * Named levels, keyed by the `level` each choice carries. These are the
       * only labels the picker shows — the model id is secondary text on the
       * confirm screen and nowhere else, because this is the last thing read
       * before an operation that cannot be undone.
       */
      levels: { standard: LevelCopy; finer: LevelCopy; finest: LevelCopy };
      sameAsCurrent: string;
      dirtyNote: string;
      startButton: string;
      confirmTitle: string;
      /** The one full-weight sentence on a screen that is otherwise all grey. */
      confirmLead: string;
      confirmBody: string;
      point1: string;
      point2: string;
      /** How long, expressed in rounds — the only unit that can be honest. */
      point3: string;
      point4: string;
      targetLine: string;
      /** The raw model id, for anyone who wants to audit what they picked. */
      modelLine: string;
      confirmButton: string;
      cancelButton: string;
      startingTitle: string;
      startingBody: string;
      runningTitle: string;
      runningBody: string;
      pauseButton: string;
      pausing: string;
      pausedTitle: string;
      pausedBody: string;
      progress: string;
      progressPending: string;
      skipped: string;
      stalledTitle: string;
      stalledBody: string;
      /** The other stall: one memory keeps failing, so waiting cannot help. */
      stalledFailingTitle: string;
      stalledFailingBody: string;
      resumeButton: string;
      startOverButton: string;
      startOverNote: string;
      resettingTitle: string;
      resettingBody: string;
      interruptedTitle: string;
      interruptedBody: string;
      failedTitle: string;
      failedBody: string;
      stuckTitle: string;
      stuck: string;
      doneTitle: string;
      doneBody: string;
      changeAgain: string;
      freeLabel: string;
      freeDesc: string;
      freeButton: string;
      freeConfirm: string;
      freeKeep: string;
      freeing: string;
      freeingBody: string;
      freedTitle: string;
      freedBody: string;
      loading: string;
      loadFailed: string;
      barRunning: string;
      barWorking: string;
    };
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
    chooseLede: string;
    signInButton: string;
    signInHint: string;
    signInFootnote: string;
    manualButton: string;
    accountPickerTitle: string;
    accountPickerLede: string;
    searchingTitle: string;
    searchingLede: string;
    searchingStep: string;
    pickTitleOne: string;
    pickTitleMany: string;
    pickLedeOne: string;
    pickLedeMany: string;
    noneFound: string;
    unlockTitle: string;
    unlockLede: string;
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
