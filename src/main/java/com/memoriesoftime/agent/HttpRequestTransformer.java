package com.memoriesoftime.agent;

import java.lang.instrument.ClassFileTransformer;
import java.security.ProtectionDomain;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.Label;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

final class HttpRequestTransformer implements ClassFileTransformer {
    static final String TARGET = "jdk/internal/net/http/HttpRequestImpl";
    static final String FROM = "https://bin-data.nkmot.com/";
    static final String TO = "https://raw.githubusercontent.com/MemoriesOfTime/Bin_Data/main/";

    volatile Throwable failure;
    volatile int patchedAssignments;

    @Override
    public byte[] transform(ClassLoader loader, String name, Class<?> redefinedClass,
                            ProtectionDomain domain, byte[] bytes) {
        if (!TARGET.equals(name)) {
            return null;
        }
        try {
            ClassReader reader = new ClassReader(bytes);
            ClassWriter writer = new ClassWriter(reader, ClassWriter.COMPUTE_FRAMES);
            int[] assignments = {0};
            reader.accept(new ClassVisitor(Opcodes.ASM9, writer) {
                @Override
                public MethodVisitor visitMethod(int access, String method, String descriptor,
                                                 String signature, String[] exceptions) {
                    MethodVisitor original = super.visitMethod(access, method, descriptor, signature, exceptions);
                    if (!"<init>".equals(method)) {
                        return original;
                    }
                    return new MethodVisitor(Opcodes.ASM9, original) {
                        @Override
                        public void visitFieldInsn(int opcode, String owner, String field, String type) {
                            if (opcode == Opcodes.PUTFIELD && TARGET.equals(owner)
                                    && "uri".equals(field) && "Ljava/net/URI;".equals(type)) {
                                rewriteUri(mv);
                                assignments[0]++;
                            }
                            super.visitFieldInsn(opcode, owner, field, type);
                        }
                    };
                }
            }, ClassReader.SKIP_FRAMES);
            if (assignments[0] == 0) {
                throw new IllegalStateException("No HttpRequestImpl URI assignments found");
            }
            byte[] transformed = writer.toByteArray();
            patchedAssignments = assignments[0];
            failure = null;
            return transformed;
        } catch (RuntimeException | LinkageError e) {
            // Transformer exceptions normally get ignored by the JVM. Record the
            // failure so premain can refuse to report a successful installation.
            failure = e;
            System.err.println("[nukkit-mot-javaagent] Transformation failed: " + e);
            throw e;
        }
    }

    private static void rewriteUri(MethodVisitor mv) {
        // Stack on entry/exit: [request, URI]. Only java.base calls are injected,
        // so the platform-loaded class never has to resolve an agent helper.
        Label unchanged = new Label();
        mv.visitInsn(Opcodes.DUP);
        mv.visitJumpInsn(Opcodes.IFNULL, unchanged);
        mv.visitInsn(Opcodes.DUP);
        mv.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/net/URI", "toString", "()Ljava/lang/String;", false);
        mv.visitLdcInsn(FROM);
        mv.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/String", "startsWith", "(Ljava/lang/String;)Z", false);
        mv.visitJumpInsn(Opcodes.IFEQ, unchanged);
        mv.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/net/URI", "toString", "()Ljava/lang/String;", false);
        mv.visitLdcInsn(FROM.length());
        mv.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/String", "substring", "(I)Ljava/lang/String;", false);
        mv.visitLdcInsn(TO);
        mv.visitInsn(Opcodes.SWAP);
        mv.visitMethodInsn(Opcodes.INVOKEVIRTUAL, "java/lang/String", "concat", "(Ljava/lang/String;)Ljava/lang/String;", false);
        mv.visitMethodInsn(Opcodes.INVOKESTATIC, "java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", false);
        mv.visitLabel(unchanged);
    }
}
