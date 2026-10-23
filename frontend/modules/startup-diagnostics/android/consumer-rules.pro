# Native vendor observation calls this one observer reflectively.
-keep class expo.modules.startupdiagnostics.EvidenceTrace {
    public static void record(android.content.Context, java.lang.String, java.lang.String, java.lang.String, java.lang.String);
}
-keepclassmembers class com.facebook.react.modules.network.NetworkingModule {
    private static com.facebook.react.modules.network.CustomClientBuilder customClientBuilder;
}
-keep class expo.modules.startupdiagnostics.RequestOrigins {
    public static void install(android.content.Context);
    public static void record(java.lang.String, java.lang.String, java.lang.String, java.lang.String);
}
-keep class expo.modules.startupdiagnostics.HeadlessTaskLifetimes {
    public static java.lang.String begin(int, java.util.function.BooleanSupplier);
    public static void end(java.lang.String);
}
