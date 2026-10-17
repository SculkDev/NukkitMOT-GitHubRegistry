package com.memoriesoftime.agent;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.jar.Attributes;
import java.util.jar.JarEntry;
import java.util.jar.JarOutputStream;
import java.util.jar.Manifest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class AgentIT {
    @TempDir
    Path temp;

    @Test
    void baselineWithoutAgent() throws Exception {
        probe(false, null);
    }

    @Test
    void packagedAgentRewritesRequests() throws Exception {
        probe(true, null);
    }

    @Test
    void handlesHttpClientLoadedByEarlierAgent() throws Exception {
        Path preload = temp.resolve("preload-agent.jar");
        Manifest manifest = new Manifest();
        manifest.getMainAttributes().put(Attributes.Name.MANIFEST_VERSION, "1.0");
        manifest.getMainAttributes().putValue("Premain-Class", PreloadAgent.class.getName());
        String className = PreloadAgent.class.getName().replace('.', '/') + ".class";
        try (JarOutputStream jar = new JarOutputStream(Files.newOutputStream(preload), manifest)) {
            jar.putNextEntry(new JarEntry(className));
            Files.copy(Path.of(System.getProperty("agent.test.classes"), className), jar);
            jar.closeEntry();
        }
        probe(true, preload);
    }

    private void probe(boolean active, Path preload) throws Exception {
        List<String> command = new ArrayList<>();
        command.add(System.getProperty("agent.test.java"));
        command.add("-Xverify:all");
        if (preload != null) {
            command.add("-javaagent:" + preload.toAbsolutePath());
        }
        if (active) {
            command.add("-javaagent:" + System.getProperty("agent.jar"));
        }
        command.add("-cp");
        command.add(System.getProperty("agent.test.classes"));
        command.add(AgentProbe.class.getName());
        command.add(Boolean.toString(active));
        Path output = temp.resolve("probe-output.txt");
        Process process = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(output.toFile()).start();
        boolean completed = process.waitFor(30, TimeUnit.SECONDS);
        if (!completed) {
            process.destroyForcibly();
        }
        String log = Files.readString(output, StandardCharsets.UTF_8);
        assertTrue(completed, "Probe timed out: " + log);
        assertEquals(0, process.exitValue(), log);
        assertTrue(log.contains("PASS: active=" + active), log);
        assertEquals(active, log.contains("[nukkit-mot-javaagent] Active:"), log);
    }
}
