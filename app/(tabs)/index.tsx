import React, { useState, useRef, useEffect } from 'react';
import { 
  StyleSheet, 
  Text, 
  View, 
  TouchableOpacity, 
  TextInput, 
  SafeAreaView, 
  Alert,
  Keyboard,
  TouchableWithoutFeedback,
  KeyboardAvoidingView,
  Platform,
  useWindowDimensions
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as MediaLibrary from 'expo-media-library'; 
import * as ScreenOrientation from 'expo-screen-orientation'; 

// --- Firebase Imports ---
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, onSnapshot, updateDoc } from 'firebase/firestore';

// ⚠️ WICHTIG: Füge hier deine echten Firebase-Konfigurationsdaten ein! ⚠️
// Solange hier Platzhalter stehen, funktioniert die automatische Cloud-Verbindung nicht.
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

export default function App() {
  const { width, height } = useWindowDimensions(); 
  const [permission, requestPermission] = useCameraPermissions();
  const [mediaPermission, requestMediaPermission] = MediaLibrary.usePermissions(); 
  
  const [role, setRole] = useState<'setup' | 'host' | 'client'>('setup');
  const [sessionId, setSessionId] = useState<string>('');
  const [joinCode, setJoinCode] = useState<string>('');
  const [isReady, setIsReady] = useState(false);
  
  // Firebase Sync States
  const [clientConnected, setClientConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  
  const cameraRef = useRef<any>(null);
  const isRecordingRef = useRef(false);

  // --- ECHTZEIT SYNCHRONISATION (Firebase) ---
  useEffect(() => {
    if (!sessionId) return;

    try {
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
      }, (error) => {
        console.log("Firebase Listener wartet (Offline-Modus aktiv)");
      });

      return () => unsubscribe();
    } catch (e) {
      console.log("Offline-Modus aktiv");
    }
  }, [sessionId]);

  // 1. Berechtigungen prüfen
  if (!permission || !mediaPermission) return <View style={styles.container} />;
  
  if (!permission.granted || !mediaPermission.granted) {
    const requestAllPermissions = async () => {
      await requestPermission();
      await requestMediaPermission();
    };

    return (
      <View style={styles.centeredContainer}>
        <Text style={styles.title}>Zugriff erforderlich</Text>
        <Text style={styles.subtitle}>Wir benötigen Zugriff auf die Kamera und Fotos-App.</Text>
        <TouchableOpacity style={styles.primaryButton} onPress={requestAllPermissions}>
          <Text style={styles.buttonText}>Zugriff erlauben</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // 2. Setup-Funktionen (SOFORTIGER UI-WECHSEL)
  const createSession = async () => {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    
    // 1. UI SOFORT aktualisieren, um Hänger zu vermeiden!
    setSessionId(code);
    setRole('host');
    setIsReady(true); 

    // 2. Versuch, das Querformat zu aktivieren
    try {
      await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
    } catch (e) {
      console.warn("Querformat konnte nicht geladen werden.");
    }

    // 3. Versuch, Firebase im Hintergrund zu kontaktieren
    try {
      await setDoc(doc(db, 'veo_sessions', code), {
        hostConnected: true,
        clientConnected: false,
        recording: false
      });
    } catch (error) {
      console.log("Firebase Fehler (Ignoriert für Testmodus)");
    }
  };

  const joinSession = async () => {
    if (joinCode.length !== 4) {
      Alert.alert('Ungültiger Code', 'Bitte gib einen 4-stelligen Code ein.');
      return;
    }
    
    // 1. UI SOFORT aktualisieren
    setSessionId(joinCode);
    setRole('client');
    setIsReady(true);

    try {
      await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
    } catch (e) {}

    try {
      await updateDoc(doc(db, 'veo_sessions', joinCode), {
        clientConnected: true
      });
    } catch (error) {
      console.log("Firebase Fehler (Ignoriert für Testmodus)");
    }
  };

  const leaveSession = async () => {
    if (isRecordingRef.current) {
      Alert.alert('Aufnahme läuft', 'Bitte stoppe die Aufnahme zuerst.');
      return;
    }
    try {
      await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
    } catch (e) {}
    
    setIsReady(false);
    setRole('setup');
    setSessionId('');
    setJoinCode('');
    setClientConnected(false);
  };

  // 3. Aufnahme-Steuerung
  const toggleRecordingHost = async () => {
    if (role !== 'host' || !clientConnected) return;
    
    const newState = !isRecordingRef.current;
    
    try {
      await updateDoc(doc(db, 'veo_sessions', sessionId), {
        recording: newState
      });
    } catch (error) {
      // FALLBACK für den Testmodus ohne echtes Firebase
      if (newState) {
        startActualRecording();
      } else {
        stopActualRecording();
      }
    }
  };

  const startActualRecording = async () => {
    if (!cameraRef.current) return;
    isRecordingRef.current = true;
    setIsRecording(true);
    
    try {
      const video = await cameraRef.current.recordAsync({ maxDuration: 300 });
      if (video && video.uri) {
        await MediaLibrary.saveToLibraryAsync(video.uri);
        Alert.alert('Gespeichert! 🎬', 'Video wurde in der Mediathek abgelegt.');
      }
    } catch (error) {
      console.error(error);
      isRecordingRef.current = false;
      setIsRecording(false);
    }
  };

  const stopActualRecording = () => {
    if (!cameraRef.current) return;
    cameraRef.current.stopRecording();
    isRecordingRef.current = false;
    setIsRecording(false);
  };

  // --- RENDER: SETUP BILSCHIRM ---
  if (!isReady) {
    return (
      <SafeAreaView style={styles.container}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
          <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
            <View style={styles.setupContent}>
              <Text style={styles.title}>VeoClone Einrichtung</Text>
              
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Kamera A (Host)</Text>
                <TouchableOpacity style={styles.primaryButton} onPress={createSession}>
                  <Text style={styles.buttonText}>Session erstellen</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.divider} />

              <View style={styles.card}>
                <Text style={styles.cardTitle}>Kamera B (Client)</Text>
                <TextInput 
                  style={styles.input}
                  placeholder="PIN eingeben"
                  placeholderTextColor="#666"
                  keyboardType="number-pad"
                  maxLength={4}
                  value={joinCode}
                  onChangeText={(text) => {
                    setJoinCode(text);
                    if (text.length === 4) Keyboard.dismiss();
                  }}
                />
                <TouchableOpacity style={styles.secondaryButton} onPress={joinSession}>
                  <Text style={styles.buttonText}>Beitreten</Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableWithoutFeedback>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // --- RENDER: KAMERA BILSCHIRM ---
  return (
    <View style={styles.container}>
      <CameraView style={StyleSheet.absoluteFillObject} facing="back" mode="video" ref={cameraRef} />

      {/* DYNAMISCHES AUSRICHTUNGS-RASTER FÜR SEITENLINIEN-SETUP IM QUERFORMAT */}
      <View style={styles.gridContainer} pointerEvents="none">
        <View style={[styles.horizontalLine, { top: height * 0.4 }]} />
        <Text style={[styles.horizonText, { top: (height * 0.4) - 25 }]}>Spielfeldrand / Horizont</Text>

        {role === 'host' && (
          <>
            <View style={[styles.verticalLine, { left: '80%' }]} />
            <Text style={[styles.verticalText, { left: '81%', width: 120, top: height * 0.15 }]}>Mittellinie hier (Überlappung)</Text>
            <View style={[styles.overlapZone, { left: '80%', width: '20%' }]} />
          </>
        )}

        {role === 'client' && (
          <>
            <View style={[styles.verticalLine, { left: '20%' }]} />
            <Text style={[styles.verticalText, { right: '81%', width: 120, textAlign: 'right', top: height * 0.15 }]}>Mittellinie hier (Überlappung)</Text>
            <View style={[styles.overlapZone, { left: '0%', width: '20%' }]} />
          </>
        )}
      </View>

      {/* Sperr-Overlay, wenn Geräte noch nicht verbunden sind */}
      {!clientConnected && (
        <View style={styles.waitingOverlay}>
          {/* SIMULATOR TRICK FÜR DEN TESTMODUS */}
          <TouchableOpacity 
            onPress={() => setClientConnected(true)} 
            style={styles.simulateConnectButton}
          >
            <Text style={styles.waitingText}>
              {role === 'host' ? 'Warte auf Kamera B...' : 'Verbinde mit Host...'}
            </Text>
            <Text style={styles.simulateText}>
              (Tippe hier, um eine Verbindung für den Test zu simulieren)
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* UI Leiste Oben */}
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

      {/* REC Indikator */}
      {isRecording && (
        <View style={styles.recordingIndicatorLandscape}>
          <View style={styles.redDot} />
          <Text style={styles.recordingText}>REC</Text>
        </View>
      )}

      {/* Aufnahme Button - NUR SICHTBAR FÜR HOST */}
      {role === 'host' && (
        <View style={styles.rightBarLandscape}>
          <TouchableOpacity 
            style={[styles.recordOuter, !clientConnected && styles.recordDisabled]} 
            onPress={toggleRecordingHost}
            disabled={!clientConnected}
          >
            <View style={[styles.recordInner, isRecording && styles.recordInnerActive, !clientConnected && styles.recordDisabledInner]} />
          </TouchableOpacity>
        </View>
      )}

      {/* Info-Text für den Client */}
      {role === 'client' && clientConnected && (
        <View style={styles.rightBarLandscape}>
          <Text style={styles.clientWaitingText}>Warte auf Host-Signal...</Text>
        </View>
      )}
    </View>
  );
}

// --- STYLES ---
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  centeredContainer: { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', padding: 20 },
  setupContent: { flex: 1, padding: 20, justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: 'bold', color: '#fff', marginBottom: 30, textAlign: 'center' },
  subtitle: { fontSize: 16, color: '#aaa', textAlign: 'center', marginBottom: 20 },
  card: { backgroundColor: '#1c1c1e', padding: 20, borderRadius: 16, marginBottom: 20 },
  cardTitle: { fontSize: 18, fontWeight: 'bold', color: '#fff', marginBottom: 15 },
  primaryButton: { backgroundColor: '#34C759', padding: 16, borderRadius: 12, alignItems: 'center' },
  secondaryButton: { backgroundColor: '#007AFF', padding: 16, borderRadius: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontWeight: 'bold', fontSize: 16 },
  input: { backgroundColor: '#2c2c2e', color: '#fff', padding: 16, borderRadius: 12, fontSize: 18, textAlign: 'center', marginBottom: 16, letterSpacing: 4 },
  divider: { height: 1, backgroundColor: '#333', marginVertical: 10 },
  
  // Kamera UI
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

  waitingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', zIndex: 5 },
  simulateConnectButton: { alignItems: 'center', padding: 20 },
  waitingText: { color: '#fff', fontSize: 24, fontWeight: 'bold', marginBottom: 10 },
  simulateText: { color: '#888', fontSize: 14 },
  clientWaitingText: { color: '#fff', backgroundColor: 'rgba(0,0,0,0.5)', padding: 10, borderRadius: 8, fontWeight: 'bold' },

  // Raster Styles
  gridContainer: { ...StyleSheet.absoluteFillObject },
  horizontalLine: { position: 'absolute', height: 1, width: '100%', backgroundColor: 'rgba(52, 199, 89, 0.8)' },
  horizonText: { position: 'absolute', left: 40, color: 'rgba(52, 199, 89, 0.9)', fontSize: 12, fontWeight: 'bold', letterSpacing: 1 },
  verticalLine: { position: 'absolute', width: 2, height: '100%', backgroundColor: 'rgba(255, 204, 0, 0.8)', borderStyle: 'dashed' },
  verticalText: { position: 'absolute', color: 'rgba(255, 204, 0, 0.9)', fontSize: 14, fontWeight: 'bold', backgroundColor: 'rgba(0,0,0,0.5)', padding: 4, borderRadius: 4 },
  overlapZone: { position: 'absolute', height: '100%', backgroundColor: 'rgba(255, 204, 0, 0.15)' }
});
