package com.memoriesoftime.agent;

import java.lang.instrument.Instrumentation;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;

public final class PreloadAgent {
    static HttpRequest request;

    public static void premain(String arguments, Instrumentation instrumentation) {
        HttpClient.newHttpClient();
        request = HttpRequest.newBuilder(URI.create("https://bin-data.nkmot.com/preloaded.nbt")).build();
        System.setProperty("probe.preloaded", "true");
    }
}
