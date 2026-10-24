const { withDangerousMod, withAppBuildGradle } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');
const hooks = require('./deepAsyncHooks');
// AGP transforms the actual precompiled RN classes. Editing installed RN Kotlin
// alone would not instrument the artifact delivered by EAS.
const gradle = `
// KinnshipDeepAsync75: observational bytecode hooks in the delivered RN classes.
abstract class KinnshipDeepAsyncFactory implements com.android.build.api.instrumentation.AsmClassVisitorFactory<com.android.build.api.instrumentation.InstrumentationParameters.None> {
  boolean isInstrumentable(com.android.build.api.instrumentation.ClassData data) {
    return data.className == 'com.facebook.react.modules.network.ResponseUtil' ||
      data.className.startsWith('com.facebook.react.modules.blob.FileReaderModule')
  }
  org.objectweb.asm.ClassVisitor createClassVisitor(com.android.build.api.instrumentation.ClassContext context, org.objectweb.asm.ClassVisitor next) {
    def cls = context.currentClassData.className
    return new org.objectweb.asm.ClassVisitor(org.objectweb.asm.Opcodes.ASM9, next) {
      org.objectweb.asm.MethodVisitor visitMethod(int access, String name, String desc, String sig, String[] exceptions) {
        def mv = super.visitMethod(access, name, desc, sig, exceptions)
        return new org.objectweb.asm.commons.AdviceAdapter(org.objectweb.asm.Opcodes.ASM9, mv, access, name, desc) {
          void safeCall(String method, String signature, Closure push) {
            def begin = new org.objectweb.asm.Label(), end = new org.objectweb.asm.Label()
            def caught = new org.objectweb.asm.Label(), done = new org.objectweb.asm.Label()
            visitTryCatchBlock(begin, end, caught, 'java/lang/Throwable')
            visitLabel(begin); push.call()
            super.visitMethodInsn(INVOKESTATIC, 'expo/modules/startupdiagnostics/DeepAsyncTrace', method, signature, false)
            visitLabel(end); visitJumpInsn(GOTO, done)
            visitLabel(caught); visitInsn(POP); visitLabel(done)
          }
          void onMethodEnter() {
            if (cls.endsWith('.ResponseUtil') && name in ['onResponseReceived', 'onDataReceived', 'onRequestSuccess', 'onRequestError']) {
              def stage = name == 'onResponseReceived' ? 'native_response_emission_attempted' :
                name == 'onDataReceived' ? 'native_data_emission_attempted' :
                name == 'onRequestSuccess' ? 'native_completion_emission_attempted' : 'native_error_emission_attempted'
              safeCall('nativeEmission', '(Ljava/lang/Object;ILjava/lang/String;)V', {
                loadArg(0); loadArg(1); visitLdcInsn(stage)
              })
            }
            if (name == 'readAsText' && cls.endsWith('.FileReaderModule')) {
              safeCall('nativeBody', '(Ljava/lang/Object;Ljava/lang/Object;)V', {
                loadArg(0); loadArg(2)
              })
            }
          }
          void visitMethodInsn(int opcode, String owner, String method, String signature, boolean itf) {
            if (cls.contains('.FileReaderModule') && owner == 'com/facebook/react/bridge/Promise' && method in ['resolve', 'reject']) {
              def args = org.objectweb.asm.Type.getArgumentTypes(signature)
              def locals = new int[args.length]
              for (int i = args.length - 1; i >= 0; i--) {
                locals[i] = newLocal(args[i]); storeLocal(locals[i], args[i])
              }
              int receiver = newLocal(org.objectweb.asm.Type.getType(Object))
              storeLocal(receiver)
              safeCall('promiseAttempt', '(Ljava/lang/Object;Ljava/lang/String;)V', {
                loadLocal(receiver); visitLdcInsn(method == 'resolve' ? 'native_body_completion_attempted' : 'native_body_rejection_attempted')
              })
              loadLocal(receiver)
              for (int i = 0; i < args.length; i++) loadLocal(locals[i], args[i])
            }
            super.visitMethodInsn(opcode, owner, method, signature, itf)
          }
        }
      }
    }
  }
}
androidComponents.onVariants(androidComponents.selector().all()) { variant ->
  variant.instrumentation.transformClassesWith(KinnshipDeepAsyncFactory, com.android.build.api.instrumentation.InstrumentationScope.ALL) {}
  variant.instrumentation.setAsmFramesComputationMode(com.android.build.api.instrumentation.FramesComputationMode.COMPUTE_FRAMES_FOR_INSTRUMENTED_METHODS)
}
`;
function plugin(config) {
  config = withAppBuildGradle(config, mod => {
    if (!mod.modResults.contents.includes('// KinnshipDeepAsync75:')) mod.modResults.contents += '\n' + gradle;
    return mod;
  });
  return withDangerousMod(config, ['android', async mod => {
    const root = mod.modRequest.projectRoot;
    for (const [rel, transform] of [
      ['react-native/Libraries/Network/XMLHttpRequest.js', hooks.xhr],
      ['react-native/Libraries/Blob/FileReader.js', hooks.reader],
      ['whatwg-fetch/fetch.js', hooks.fetch],
      ['whatwg-fetch/dist/fetch.umd.js', hooks.fetch],
    ]) {
      const file = path.join(root, 'node_modules', rel);
      if (!fs.existsSync(file)) throw Error('Deep async hook input missing: ' + rel);
      fs.writeFileSync(file, transform(fs.readFileSync(file, 'utf8')));
    }
    return mod;
  }]);
}
module.exports = plugin;
module.exports.gradle = gradle;
