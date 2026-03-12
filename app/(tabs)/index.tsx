import React, { useState, useRef, useEffect } from 'react';
import { 
  StyleSheet, Text, View, TouchableOpacity, TextInput, 
  SafeAreaView, Alert, Keyboard, TouchableWithoutFeedback, 
  KeyboardAvoidingView, Platform, useWindowDimensions, ActivityIndicator
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ScreenOrientation from 'expo-screen-orientation'; 

// --- Firebase Imports ---
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, onSnapshot, updateDoc } from 'firebase/firestore';
import { getStorage, ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';

// ⚠️ WICHTIG: Deine eigenen Firebase-Daten (Storage muss in Firebase aktiviert sein!)
const firebaseConfig = {
  apiKey: "DEIN_API_KEY",
  authDomain: "dein-projekt.firebaseapp.com",
  projectId: "dein-projekt",
  storageBucket: "dein-projekt.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abcdef"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

export default function App() {
  const { width, height } = useWindowDimensions(); 
  const [permission, requestPermission] = useCameraPermissions();
  
  const [role, setRole] = useState<'setup' | 'host' | 'client' | 'download'>('setup');
  const [sessionId, setSessionId] = useState<string>('');
  
  // Getrennte Eingabefelder für Kopplung und Download
  const [inputCode, setInputCode] = useState<string>('');
  const [downloadCode, setDownloadCode] = useState<string>('');
  
  const [isReady, setIsReady] = useState(false);
  
  // Cloud States
  const [clientConnected, setClientConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  
  const cameraRef = useRef<any>(null);
  const isRecordingRef = useRef(false);

  // --- ECHTZEIT SYNCHRONISATION ---
  useEffect(() => {
    if (!sessionId || role === 'download') return;

    const docRef = doc(db, 'veo_sessions', sessionId);
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        setClientConnected(data.clientConnected);

        if (data.recording && !isRecordingRef.current) {
          startActualRecording();
        } else if (!data.recording && isRecordingRef.current) {
          stopActualRecording();
        }
      }
    });
    return () => unsubscribe();
  }, [sessionId, role]);

  if (!permission) return <View style={styles.container} />;
  if (!permission.granted) {
    return (
      <View style={styles.centeredContainer}>
        <Text style={styles.title}>Kamera-Zugriff</Text>
        <TouchableOpacity style={styles.primaryButton} onPress={requestPermission}>
          <Text style={styles.buttonText}>Erlauben</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // --- SETUP FUNKTIONEN ---
  const createSession = async () => {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    setSessionId(code);
    setRole('host');
    setIsReady(true); 
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(e => {});

    try {
      await setDoc(doc(db, 'veo_sessions', code), {
        hostConnected: true,
        clientConnected: false,
        recording: false,
        camA_url: null,
        camB_url: null,
        stitched_url: null,
        status: 'waiting'
      });
    } catch (e) { console.log("Firebase Fehler"); }
  };

  const joinSession = async () => {
    if (inputCode.length !== 4) return Alert.alert('Fehler', 'PIN muss 4-stellig sein');
    setSessionId(inputCode);
    setRole('client');
    setIsReady(true);
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(e => {});

    try {
      await updateDoc(doc(db, 'veo_sessions', inputCode), { clientConnected: true });
    } catch (e) { console.log("Firebase Fehler"); }
  };

  const checkDownload = async () => {
    if (downloadCode.length !== 4) return Alert.alert('Fehler', 'PIN muss 4-stellig sein');
    setRole('download');
    
    const docRef = doc(db, 'veo_sessions', downloadCode);
    onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists() && docSnap.data().stitched_url) {
        setDownloadUrl(docSnap.data().stitched_url);
      } else {
        setDownloadUrl(null);
      }
    });
  };

  const leaveSession = async () => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(e => {});
    setIsReady(false);
    setRole('setup');
    setSessionId('');
    setInputCode('');
    setDownloadCode('');
    setClientConnected(false);
    setUploadProgress(null);
    setDownloadUrl(null);
  };

  // --- AUFNAHME & CLOUD UPLOAD ---
  const toggleRecordingHost = async () => {
    if (role !== 'host' || !clientConnected) return;
    const newState = !isRecordingRef.current;
    try {
      await updateDoc(doc(db, 'veo_sessions', sessionId), { recording: newState });
    } catch (error) {
      if (newState) startActualRecording(); else stopActualRecording();
    }
  };

  const startActualRecording = async () => {
    if (!cameraRef.current) return;
    isRecordingRef.current = true;
    setIsRecording(true);
    
    try {
      const video = await cameraRef.current.recordAsync();
      setIsRecording(false);
      
      if (video && video.uri) {
        uploadVideoToCloud(video.uri);
      }
    } catch (error) {
      isRecordingRef.current = false;
      setIsRecording(false);
    }
  };

  const stopActualRecording = () => {
    if (!cameraRef.current) return;
    cameraRef.current.stopRecording();
    isRecordingRef.current = false;
  };

  const uploadVideoToCloud = async (uri: string) => {
    try {
      setUploadProgress(0);
      const response = await fetch(uri);
      const blob = await response.blob();
      
      const fileName = `session_${sessionId}_cam${role === 'host' ? 'A' : 'B'}.mp4`;
      const storageRef = ref(storage, `raw_uploads/${fileName}`);
      
      const uploadTask = uploadBytesResumable(storageRef, blob);
      
      uploadTask.on('state_changed', 
        (snapshot) => {
          const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
          setUploadProgress(Math.round(progress));
        }, 
        (error) => {
          Alert.alert("Upload Fehler", error.message);
          setUploadProgress(null);
        }, 
        async () => {
          const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
          const updateData = role === 'host' ? { camA_url: downloadURL } : { camB_url: downloadURL };
          
          await updateDoc(doc(db, 'veo_sessions', sessionId), {
            ...updateData,
            status: 'raw_uploaded'
          });
          
          Alert.alert("Upload Erfolgreich!", "Das Video ist nun in der Cloud. Dein PC kann das Stitching beginnen.");
          setUploadProgress(100);
        }
      );
    } catch (error) {
      Alert.alert("Fehler", "Video konnte nicht verarbeitet werden.");
    }
  };

  // --- RENDER: SETUP BILSCHIRM ---
  if (!isReady && role !== 'download') {
    return (
      <SafeAreaView style={styles.container}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
            <View style={styles.setupContent}>
              <Text style={styles.title}>VeoClone Cloud Setup</Text>
              
              <View style={styles.card}>
                <Text style={styles.cardTitle}>1. Neues Spiel aufzeichnen</Text>
                <TouchableOpacity style={styles.primaryButton} onPress={createSession}>
                  <Text style={styles.buttonText}>Kamera A (Host) starten</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.card}>
                <Text style={styles.cardTitle}>2. Zweite Kamera koppeln</Text>
                <TextInput 
                  style={styles.input} placeholder="PIN eingeben" placeholderTextColor="#666"
                  keyboardType="number-pad" maxLength={4} value={inputCode}
                  onChangeText={text => setInputCode(text)}
                />
                <TouchableOpacity style={styles.secondaryButton} onPress={joinSession}>
                  <Text style={styles.buttonText}>Kamera B (Client) verbinden</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.divider} />

              <View style={styles.card}>
                <Text style={styles.cardTitle}>3. Fertiges Spiel ansehen</Text>
                {/* NEU: Eigenes Eingabefeld für den Download */}
                <TextInput 
                  style={styles.input} placeholder="PIN des Spiels eingeben" placeholderTextColor="#666"
                  keyboardType="number-pad" maxLength={4} value={downloadCode}
                  onChangeText={text => setDownloadCode(text)}
                />
                <TouchableOpacity style={styles.downloadButton} onPress={checkDownload}>
                  <Text style={styles.buttonText}>Fertiges Video abrufen</Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableWithoutFeedback>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // --- RENDER: DOWNLOAD BILSCHIRM ---
  if (role === 'download') {
    return (
      <SafeAreaView style={styles.centeredContainer}>
        <Text style={styles.title}>Spiel {downloadCode}</Text>
        {downloadUrl ? (
          <View style={styles.card}>
            <Text style={{color: '#fff', marginBottom: 20, textAlign: 'center'}}>Dein fertig gestitchtes Panorama-Video ist bereit!</Text>
            <TouchableOpacity style={styles.primaryButton} onPress={() => Alert.alert("Download", downloadUrl)}>
              <Text style={styles.buttonText}>Video Öffnen / Speichern</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <Text style={{color: '#aaa', marginTop: 20}}>Der PC verarbeitet das Video noch oder die PIN ist falsch... Bitte warten.</Text>
        )}
        <TouchableOpacity style={[styles.leaveButton, {marginTop: 40}]} onPress={leaveSession}>
          <Text style={styles.leaveText}>Zurück</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // --- RENDER: KAMERA BILSCHIRM ---
  return (
    <View style={styles.container}>
      <CameraView style={StyleSheet.absoluteFillObject} facing="back" mode="video" ref={cameraRef} />

      {/* Upload Overlay */}
      {uploadProgress !== null && (
        <View style={styles.waitingOverlay}>
          <ActivityIndicator size="large" color="#34C759" />
          <Text style={styles.waitingText}>Lade in die Cloud hoch...</Text>
          <Text style={styles.waitingText}>{uploadProgress}%</Text>
        </View>
      )}

      {/* Wartebildschirm mit "Abbrechen" Button */}
      {!clientConnected && uploadProgress === null && (
        <View style={styles.waitingOverlay}>
          <Text style={styles.waitingText}>{role === 'host' ? 'Warte auf Kamera B...' : 'Verbinde mit Host...'}</Text>
          
          {/* NEU: Deutlicher Abbrechen-Button damit man nicht gefangen ist */}
          <TouchableOpacity 
            style={styles.cancelButton} 
            onPress={leaveSession}
          >
            <Text style={styles.cancelButtonText}>Abbrechen & Zurück</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.topBarLandscape}>
        <TouchableOpacity style={styles.leaveButton} onPress={leaveSession}>
          <Text style={styles.leaveText}>X</Text>
        </TouchableOpacity>
        <View style={styles.statusBadge}>
          <Text style={styles.statusText}>
            {role === 'host' ? 'Host' : 'Client'} | {clientConnected ? '🟢 Verbunden' : '🔴 Wartet'}
          </Text>
        </View>
        <View style={styles.codeBadge}>
          <Text style={styles.codeText}>PIN: {sessionId}</Text>
        </View>
      </View>

      {isRecording && (
        <View style={styles.recordingIndicatorLandscape}>
          <View style={styles.redDot} />
          <Text style={styles.recordingText}>REC</Text>
        </View>
      )}

      {role === 'host' && uploadProgress === null && (
        <View style={styles.rightBarLandscape}>
          <TouchableOpacity 
            style={[styles.recordOuter, !clientConnected && styles.recordDisabled]} 
            onPress={toggleRecordingHost} disabled={!clientConnected}
          >
            <View style={[styles.recordInner, isRecording && styles.recordInnerActive, !clientConnected && styles.recordDisabledInner]} />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  centeredContainer: { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', padding: 20 },
  setupContent: { flex: 1, padding: 20, justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', color: '#fff', marginBottom: 20, textAlign: 'center' },
  card: { backgroundColor: '#1c1c1e', padding: 20, borderRadius: 16, marginBottom: 15 },
  cardTitle: { fontSize: 16, fontWeight: 'bold', color: '#fff', marginBottom: 10 },
  primaryButton: { backgroundColor: '#34C759', padding: 14, borderRadius: 10, alignItems: 'center' },
  secondaryButton: { backgroundColor: '#007AFF', padding: 14, borderRadius: 10, alignItems: 'center' },
  downloadButton: { backgroundColor: '#FF9500', padding: 14, borderRadius: 10, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  input: { backgroundColor: '#2c2c2e', color: '#fff', padding: 14, borderRadius: 10, fontSize: 16, textAlign: 'center', marginBottom: 10, letterSpacing: 4 },
  divider: { height: 1, backgroundColor: '#333', marginVertical: 10 },
  topBarLandscape: { position: 'absolute', top: 20, left: 40, right: 40, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', zIndex: 10 },
  leaveButton: { backgroundColor: 'rgba(0,0,0,0.6)', width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
  leaveText: { color: '#fff', fontWeight: 'bold', fontSize: 18 },
  statusBadge: { backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  statusText: { color: '#fff', fontWeight: 'bold' },
  codeBadge: { backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)' },
  codeText: { color: '#fff', fontWeight: 'bold', fontFamily: 'Courier' },
  rightBarLandscape: { position: 'absolute', right: 40, top: '50%', marginTop: -40, alignItems: 'center', zIndex: 10 },
  recordOuter: { width: 80, height: 80, borderRadius: 40, borderWidth: 4, borderColor: '#fff', justifyContent: 'center', alignItems: 'center' },
  recordInner: { width: 66, height: 66, borderRadius: 33, backgroundColor: '#FF3B30' },
  recordInnerActive: { width: 40, height: 40, borderRadius: 8 },
  recordDisabled: { borderColor: 'rgba(255,255,255,0.3)' },
  recordDisabledInner: { backgroundColor: 'rgba(255, 59, 48, 0.3)' },
  recordingIndicatorLandscape: { position: 'absolute', top: 30, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255, 59, 48, 0.8)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 16, zIndex: 10 },
  redDot: { width: 8, height: 8, backgroundColor: '#fff', borderRadius: 4, marginRight: 6 },
  recordingText: { color: '#fff', fontWeight: 'bold' },
  waitingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center', zIndex: 20 },
  waitingText: { color: '#fff', fontSize: 20, fontWeight: 'bold', marginTop: 15 },
  cancelButton: { marginTop: 30, backgroundColor: 'rgba(255,255,255,0.15)', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 25, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },
  cancelButtonText: { color: '#fff', fontWeight: 'bold', fontSize: 16 }
});
