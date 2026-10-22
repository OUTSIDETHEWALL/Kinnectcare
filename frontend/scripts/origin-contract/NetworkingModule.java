package com.facebook.react.modules.network;
import okhttp3.OkHttpClient;
public class NetworkingModule {
  private static CustomClientBuilder customClientBuilder;
  public static void setCustomClientBuilder(CustomClientBuilder value) { customClientBuilder = value; }
  public static void apply(OkHttpClient.Builder builder) { customClientBuilder.apply(builder); }
  public interface CustomClientBuilder { void apply(OkHttpClient.Builder builder); }
}
