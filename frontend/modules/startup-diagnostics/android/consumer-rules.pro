# Native vendor observation calls this one observer reflectively.
-keep class expo.modules.startupdiagnostics.EvidenceTrace {
    public static void record(android.content.Context, java.lang.String, java.lang.String, java.lang.String, java.lang.String);
}
