package com.memoriesoftime.agent;

import java.lang.instrument.Instrumentation;

/** Startup agent for the OpenJDK java.net.http implementation. */
public final class MirrorAgent {
    private MirrorAgent() {
    }

    public static void premain(String arguments, Instrumentation instrumentation) throws Exception {
        if (arguments != null && !arguments.isBlank()) {
            throw new IllegalArgumentException("This agent takes no arguments");
        }
        if (!instrumentation.isRetransformClassesSupported()) {
            throw new IllegalStateException("This JVM does not support class retransformation");
        }

        // Load without initializing, then retransform: this also handles a class
        // already loaded by an earlier agent. No module opens/exports are needed.
        Class<?> requestClass = Class.forName(HttpRequestTransformer.TARGET.replace('/', '.'),
                false, ClassLoader.getPlatformClassLoader());
        if (!instrumentation.isModifiableClass(requestClass)) {
            throw new IllegalStateException("The JVM's HttpRequestImpl cannot be modified");
        }
        HttpRequestTransformer transformer = new HttpRequestTransformer();
        instrumentation.addTransformer(transformer, true);
        instrumentation.retransformClasses(requestClass);
        if (transformer.failure != null || transformer.patchedAssignments == 0) {
            throw new IllegalStateException("Unable to patch java.net.http on this JVM", transformer.failure);
        }
        System.err.println("[nukkit-mot-javaagent] Active: " + HttpRequestTransformer.FROM
                + " -> " + HttpRequestTransformer.TO);
    }
}
