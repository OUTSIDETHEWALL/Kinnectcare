const { withDangerousMod, withSettingsGradle, withAppBuildGradle, withMainApplication } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');
const h = require('./schedulingHooks');
const deep = require('./deepAsyncHooks');
const MARK = h.MARK;

// At EVERY invocation of an RN synchronized task method, capture its listener
// observations in bounded owned scratch until the original outer call returns.
// Do not remove RN monitors or move application callbacks.
const monitorGradle = `
// ${MARK}: monitor-aware observation admission.
abstract class KinnshipMonitorFactory implements com.android.build.api.instrumentation.AsmClassVisitorFactory<com.android.build.api.instrumentation.InstrumentationParameters.None> {
  boolean isInstrumentable(com.android.build.api.instrumentation.ClassData data) {
    return !data.className.startsWith('com.facebook.react.runtime.SchedulingProbe')
  }
  org.objectweb.asm.ClassVisitor createClassVisitor(com.android.build.api.instrumentation.ClassContext context, org.objectweb.asm.ClassVisitor next) {
    return new org.objectweb.asm.ClassVisitor(org.objectweb.asm.Opcodes.ASM9, next) {
      org.objectweb.asm.MethodVisitor visitMethod(int access, String name, String desc, String sig, String[] exceptions) {
        def mv = super.visitMethod(access, name, desc, sig, exceptions)
        def originalAnalysis = [null]
        def adapter = new org.objectweb.asm.commons.GeneratorAdapter(org.objectweb.asm.Opcodes.ASM9, mv, access, name, desc) {
          def originalHandlers = []
          def originalAnnotations = []
          int injectedHandlers = 0
          void visitTryCatchBlock(org.objectweb.asm.Label start, org.objectweb.asm.Label end, org.objectweb.asm.Label handler, String type) {
            originalHandlers.add([start, end, handler, type])
          }
          org.objectweb.asm.AnnotationVisitor visitTryCatchAnnotation(int ref, org.objectweb.asm.TypePath path, String descriptor, boolean visible) {
            def node = new org.objectweb.asm.tree.AnnotationNode(descriptor)
            originalAnnotations.add([ref, path, descriptor, visible, node])
            return node
          }
          void visitMaxs(int maxStack, int maxLocals) {
            // New cleanup handlers must run BEFORE existing application catches.
            // Rethrow then reaches the original catch with the original exception.
            originalHandlers.each { h -> super.visitTryCatchBlock(h[0], h[1], h[2], h[3]) }
            originalAnnotations.each { a ->
              int oldIndex = (a[0] & 0x00ffff00) >>> 8
              int ref = org.objectweb.asm.TypeReference.newTryCatchReference(oldIndex + injectedHandlers).value
              a[4].accept(super.visitTryCatchAnnotation(ref, a[1], a[2], a[3]))
            }
            super.visitMaxs(maxStack, maxLocals)
          }
          void probe(String method) {
            def begin = new org.objectweb.asm.Label(), end = new org.objectweb.asm.Label()
            def caught = new org.objectweb.asm.Label(), done = new org.objectweb.asm.Label()
            super.visitTryCatchBlock(begin, end, caught, 'java/lang/Throwable')
            injectedHandlers++
            visitLabel(begin)
            super.visitMethodInsn(org.objectweb.asm.Opcodes.INVOKESTATIC, 'com/facebook/react/runtime/SchedulingProbe', method, '()V', false)
            visitLabel(end); visitJumpInsn(org.objectweb.asm.Opcodes.GOTO, done)
            visitLabel(caught); visitInsn(org.objectweb.asm.Opcodes.POP); visitLabel(done)
          }
          void visitMethodInsn(int opcode, String owner, String method, String signature, boolean itf) {
            if (owner != 'com/facebook/react/jstasks/HeadlessJsTaskContext' || !(method in ['startTask', 'finishTask', 'retryTask', 'addTaskEventListener']) || originalAnalysis[0].stack == null) {
              super.visitMethodInsn(opcode, owner, method, signature, itf); return
            }
            def args = org.objectweb.asm.Type.getArgumentTypes(signature)
            boolean isStatic = opcode == org.objectweb.asm.Opcodes.INVOKESTATIC
            int consumed = isStatic ? 0 : 1
            args.each { consumed += it.size }
            def prefix = new ArrayList(originalAnalysis[0].stack.subList(0, originalAnalysis[0].stack.size() - consumed))
            def saved = new int[args.length]
            for (int i = args.length - 1; i >= 0; i--) {
              saved[i] = newLocal(args[i]); storeLocal(saved[i], args[i])
            }
            int receiver = -1
            if (!isStatic) { receiver = newLocal(org.objectweb.asm.Type.getType(Object)); storeLocal(receiver) }
            // Catch handlers discard the operand stack. Preserve every value
            // below the invocation, including NEW/uninitialized and wide values.
            def preserved = []
            for (int i = prefix.size() - 1; i >= 0; i--) {
              def slot = prefix[i]
              if (slot == org.objectweb.asm.Opcodes.TOP) { slot = prefix[--i] }
              def type = slot == org.objectweb.asm.Opcodes.LONG ? org.objectweb.asm.Type.LONG_TYPE :
                slot == org.objectweb.asm.Opcodes.DOUBLE ? org.objectweb.asm.Type.DOUBLE_TYPE :
                slot == org.objectweb.asm.Opcodes.INTEGER ? org.objectweb.asm.Type.INT_TYPE :
                slot == org.objectweb.asm.Opcodes.FLOAT ? org.objectweb.asm.Type.FLOAT_TYPE :
                slot instanceof String ? org.objectweb.asm.Type.getObjectType(slot) : org.objectweb.asm.Type.getType(Object)
              int local = newLocal(type); storeLocal(local, type)
              preserved.add(0, [local, type])
            }
            probe('hold')
            def begin = new org.objectweb.asm.Label(), end = new org.objectweb.asm.Label()
            def caught = new org.objectweb.asm.Label(), done = new org.objectweb.asm.Label()
            super.visitTryCatchBlock(begin, end, caught, 'java/lang/Throwable'); visitLabel(begin)
            injectedHandlers++
            if (!isStatic) loadLocal(receiver)
            for (int i = 0; i < args.length; i++) loadLocal(saved[i], args[i])
            super.visitMethodInsn(opcode, owner, method, signature, itf)
            def result = org.objectweb.asm.Type.getReturnType(signature)
            int value = -1
            if (result.sort != org.objectweb.asm.Type.VOID) { value = newLocal(result); storeLocal(value, result) }
            visitLabel(end); probe('release')
            visitJumpInsn(org.objectweb.asm.Opcodes.GOTO, done)
            visitLabel(caught)
            int thrown = newLocal(org.objectweb.asm.Type.getType(Throwable)); storeLocal(thrown)
            probe('release'); loadLocal(thrown); visitInsn(org.objectweb.asm.Opcodes.ATHROW)
            visitLabel(done)
            preserved.each { loadLocal(it[0], it[1]) }
            if (value >= 0) loadLocal(value, result)
          }
        }
        // Analyze ORIGINAL instructions outside the rewriting adapter; synthetic
        // handler branches must not destroy the original stack's type evidence.
        def analyzer = new org.objectweb.asm.commons.AnalyzerAdapter(context.currentClassData.className.replace('.', '/'), access, name, desc, adapter)
        originalAnalysis[0] = analyzer
        return new org.objectweb.asm.tree.MethodNode(org.objectweb.asm.Opcodes.ASM9, access, name, desc, sig, exceptions) {
          void visitEnd() {
            boolean guarded = instructions.any {
              it instanceof org.objectweb.asm.tree.MethodInsnNode &&
                it.owner == 'com/facebook/react/jstasks/HeadlessJsTaskContext' &&
                it.name in ['startTask', 'finishTask', 'retryTask', 'addTaskEventListener']
            }
            // Do not remap locals/frames in methods that receive no guard.
            accept(guarded ? analyzer : mv)
          }
        }
      }
    }
  }
}
androidComponents.onVariants(androidComponents.selector().all()) { variant ->
  variant.instrumentation.transformClassesWith(KinnshipMonitorFactory, com.android.build.api.instrumentation.InstrumentationScope.ALL) {}
  variant.instrumentation.setAsmFramesComputationMode(com.android.build.api.instrumentation.FramesComputationMode.COMPUTE_FRAMES_FOR_INSTRUMENTED_CLASSES)
}
`;
const settings = `
// ${MARK}: editing node_modules alone does not alter a precompiled RN AAR.
includeBuild('../node_modules/react-native') {
  dependencySubstitution {
    substitute(module("com.facebook.react:react-android")).using(project(":packages:react-native:ReactAndroid"))
     substitute(module("com.facebook.react:react-native")).using(project(":packages:react-native:ReactAndroid"))
  }
}
`;
const transforms = [
  ['ReactAndroid/hermes-engine/build.gradle.kts', hermesArchiveRoot],
  ['ReactCommon/react/runtime/TimerManager.h', h.timerHeader],
  ['ReactCommon/react/runtime/TimerManager.cpp', h.timerCpp],
  ['ReactCommon/react/runtime/ReactInstance.cpp', h.instanceCpp],
  ['ReactCommon/react/renderer/runtimescheduler/RuntimeScheduler_Modern.cpp', h.schedulerCpp],
  ['ReactAndroid/src/main/java/com/facebook/react/modules/core/JavaTimerManager.kt', h.javaTimer],
  ['ReactAndroid/src/main/java/com/facebook/react/runtime/ReactInstance.kt', h.instanceKt],
  ['ReactAndroid/src/main/jni/react/runtime/jni/JJSTimerExecutor.cpp',
    s => s.includes(MARK) ? s : s + `\n// ${MARK}\n#include <react/runtime/SchedulingJni.h>\n`],
  ['ReactAndroid/src/main/jni/react/runtime/jni/JReactInstance.cpp',
    s => s.includes(MARK) ? s : h.once(`#include <react/runtime/SchedulingCore.h>\n// ${MARK}\n` + s,
      '// TODO(janzer): Lazily create runtime',
      'kinnship78::initialize(); // explicit instance lifecycle, never a producer\n  // TODO(janzer): Lazily create runtime')],
];
function hermesArchiveRoot(contents) {
  const old = 'this.path.startsWith("facebook-hermes-")';
  const replacement = '(this.path.startsWith("facebook-hermes-") || this.path.startsWith("meta-hermes-"))';
  if (contents.includes(replacement)) return contents;
  if (!contents.includes(old)) throw new Error('Pinned Hermes archive extraction anchor changed');
  return contents.replace(old, replacement);
}
function apply(root) {
  const rn = path.join(root, 'node_modules/react-native');
  if (JSON.parse(fs.readFileSync(path.join(rn, 'package.json'))).version !== '0.81.5') throw Error('Build78 requires pinned RN 0.81.5');
  // Compute every transform before writing anything: drift cannot leave half a patch.
  const pending = transforms.map(([file, transform]) => [
    path.join(rn, file), transform(fs.readFileSync(path.join(rn, file), 'utf8')),
  ]);
  for (const file of ['whatwg-fetch/fetch.js', 'whatwg-fetch/dist/fetch.umd.js']) {
    const p = path.join(root, 'node_modules', file);
    pending.push([p, h.fetch(deep.fetch(fs.readFileSync(p, 'utf8')))]);
  }
  pending.push([path.join(rn, 'ReactAndroid/src/main/java/com/facebook/react/runtime/SchedulingProbe.kt'), h.javaProbe]);
  for (const name of ['SchedulingCore.h', 'SchedulingJni.h']) pending.push([
    path.join(rn, 'ReactCommon/react/runtime', name),
    fs.readFileSync(path.join(root, 'modules/startup-diagnostics/native', name), 'utf8'),
  ]);
  for (const [file, content] of pending) fs.writeFileSync(file, content);
}
function injectApplication(contents) {
  const install = 'expo.modules.startupdiagnostics.SchedulingTrace.install(this)';
  if (contents.includes(install)) return contents;
  // Expo mods compose in reverse registration order. Never depend on another
  // plugin having already injected its bootstrap statement.
  return h.once(contents, 'super.onCreate()', `super.onCreate()
    try { ${install} } catch (_: Throwable) { /* observation only */ }`);
}
function plugin(config) {
  const build = require('./diagnosticBuild').diagnosticBuild();
  if (build === null || build < 78) return config;
  config = withSettingsGradle(config, mod => {
    if (!mod.modResults.contents.includes(MARK)) mod.modResults.contents += settings;
    return mod;
  });
  config = withAppBuildGradle(config, mod => {
    if (!mod.modResults.contents.includes(MARK)) mod.modResults.contents += monitorGradle;
    return mod;
  });
  config = withMainApplication(config, mod => {
    mod.modResults.contents = injectApplication(mod.modResults.contents);
    return mod;
  });
  return withDangerousMod(config, ['android', async mod => {
    apply(mod.modRequest.projectRoot);
    return mod;
  }]);
}
module.exports = plugin;
Object.assign(module.exports, { apply, transforms, monitorGradle, settings, injectApplication, hermesArchiveRoot });
