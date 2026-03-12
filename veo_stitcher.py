import cv2
import numpy as np
import torch
import os
import argparse
from ultralytics import YOLO
from collections import deque

# --- KONFIGURATION ---
DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'
FPS = 30
OUT_RES = (1920, 1080)

class VeoProcessor:
    def __init__(self, model_path='yolov8n.pt'):
        print(f"[*] Initialisiere System auf Gerät: {DEVICE}")
        self.model = YOLO(model_path).to(DEVICE)
        self.smoothing_factor = 0.05
        self.center_x, self.center_y = 0, 0
        self.ball_history = deque(maxlen=15)

    def get_homography(self, img_left, img_right):
        """Berechnet die Ausrichtung mit SIFT und Lowe's Ratio Test für maximale Präzision."""
        # SIFT ist genauer als ORB für solche Aufgaben
        sift = cv2.SIFT_create()
        
        # Keypoints und Deskriptoren finden
        kp1, des1 = sift.detectAndCompute(img_right, None)
        kp2, des2 = sift.detectAndCompute(img_left, None)
        
        # FLANN Matcher (Schnelle Suche nach Übereinstimmungen)
        FLANN_INDEX_KDTREE = 1
        index_params = dict(algorithm = FLANN_INDEX_KDTREE, trees = 5)
        search_params = dict(checks=50)   
        flann = cv2.FlannBasedMatcher(index_params, search_params)
        
        matches = flann.knnMatch(des1, des2, k=2)

        # Lowe's Ratio Test (filtert schlechte/mehrdeutige Matches aus weißen Wänden rigoros aus)
        good_matches = []
        for m, n in matches:
            if m.distance < 0.75 * n.distance:
                good_matches.append(m)
                
        print(f"[*] Gefundene gute Übereinstimmungen (Schnittpunkte): {len(good_matches)}")

        if len(good_matches) > 10:
            src_pts = np.float32([ kp1[m.queryIdx].pt for m in good_matches ]).reshape(-1,1,2)
            dst_pts = np.float32([ kp2[m.trainIdx].pt for m in good_matches ]).reshape(-1,1,2)

            # Homographie berechnen (Wie muss das rechte Bild verzerrt werden?)
            H, mask = cv2.findHomography(src_pts, dst_pts, cv2.RANSAC, 5.0)
            return H
        else:
            print("[!] Fehler: Nicht genug Übereinstimmungen für ein sauberes Stitching gefunden!")
            print("-> Tipp: Sorge für mehr Überlappung und vermeide leere/weiße Wände im Übergangsbereich.")
            return None

    def run(self, path_left, path_right, output_path):
        cap_l = cv2.VideoCapture(path_left)
        cap_r = cv2.VideoCapture(path_right)
        
        ret1, img_l = cap_l.read()
        ret2, img_r = cap_r.read()
        
        if not ret1 or not ret2:
            print("[!] Fehler beim Lesen der Videodateien.")
            return

        print("[*] Berechne Bild-Ausrichtung (Homographie)...")
        H = self.get_homography(img_l, img_r)
        
        if H is None:
            return

        # --- NEU: Setup für weiches Blending (Feathering) & Größenberechnung ---
        print("[*] Bereite weiche Überblendung (Alpha-Blending) vor...")
        h, w = img_l.shape[:2]
        
        # Exakte maximale Breite des verzerrten rechten Bildes berechnen
        corners_r = np.float32([[0,0], [0,h], [w,h], [w,0]]).reshape(-1, 1, 2)
        warped_corners_r = cv2.perspectiveTransform(corners_r, H)
        max_x = int(np.max(warped_corners_r[:, 0, 0]))
        pano_w = max(w, max_x)
        
        # Distanz-Matrizen für das Alpha-Blending generieren
        mask_l = np.zeros((h, pano_w), dtype=np.uint8)
        mask_l[:, :w] = 255
        mask_r = cv2.warpPerspective(np.ones((h, w), dtype=np.uint8)*255, H, (pano_w, h))
        
        dist_l = cv2.distanceTransform(mask_l, cv2.DIST_L2, 3).astype(np.float32)
        dist_r = cv2.distanceTransform(mask_r, cv2.DIST_L2, 3).astype(np.float32)
        
        # Verblenden, wo sie sich überlappen (Vermeidung von Division durch Null)
        alpha_l = dist_l / (dist_l + dist_r + 1e-5)
        alpha_l = np.expand_dims(alpha_l, axis=2) # Kanal-Dimension hinzufügen für die Farbkanäle
        alpha_r = 1.0 - alpha_l
        print("[+] Blending-Masken erfolgreich berechnet.")
        # ------------------------------------------------------------------------

        fourcc = cv2.VideoWriter_fourcc(*'mp4v')
        out = cv2.VideoWriter(output_path, fourcc, FPS, OUT_RES)
        
        print(f"[*] Starte Processing. Ziel: {output_path}")
        
        frame_count = 0
        while True:
            ret_l, frame_l = cap_l.read()
            ret_r, frame_r = cap_r.read()
            
            if not ret_l or not ret_r:
                break
            
            # 1. STITCHING MIT QUALITÄTSVERBESSERUNG UND ALPHA-BLENDING
            # INTER_CUBIC bewahrt die Schärfe besser beim Dehnen als der Standard
            warped_r = cv2.warpPerspective(frame_r, H, (pano_w, h), flags=cv2.INTER_CUBIC)
            
            # Linkes Bild auf ein leeres Panorama-Canvas setzen
            pano_l = np.zeros((h, pano_w, 3), dtype=np.uint8)
            pano_l[:, :w] = frame_l
            
            # Die Magie: Beide Bilder werden mit der Distanzmaske sanft ineinandergeblendet
            pano = (pano_l * alpha_l + warped_r * alpha_r).astype(np.uint8)
            
            # 2. KI TRACKING (YOLOv8)
            results = self.model(pano, classes=[0, 32], verbose=False, device=DEVICE)
            
            players = []
            
            for box in results[0].boxes:
                coords = box.xyxy[0].cpu().numpy()
                cx = int((coords[0] + coords[2]) / 2)
                cy = int((coords[1] + coords[3]) / 2)
                
                if int(box.cls[0]) == 32: # Ball
                    self.ball_history.append((cx, cy))
                else: # Person
                    players.append((cx, cy))
            
            # 3. VIRTUAL CAMERA LOGIC
            target_x, target_y = self.center_x, self.center_y
            
            if len(self.ball_history) > 0:
                target_x = sum(p[0] for p in self.ball_history) / len(self.ball_history)
                target_y = sum(p[1] for p in self.ball_history) / len(self.ball_history)
            elif len(players) > 0:
                target_x = np.median([p[0] for p in players])
                target_y = np.median([p[1] for p in players])
            else:
                # Fallback: Wenn kein Ball und keine Person gefunden wird
                target_x = pano_w // 2
                target_y = h // 2

            if self.center_x == 0: 
                self.center_x, self.center_y = target_x, target_y
            else:
                self.center_x += (target_x - self.center_x) * self.smoothing_factor
                self.center_y += (target_y - self.center_y) * self.smoothing_factor
            
            # Crop Ausschnitt berechnen
            x1 = int(max(0, min(self.center_x - OUT_RES[0]//2, pano_w - OUT_RES[0])))
            y1 = int(max(0, min(self.center_y - OUT_RES[1]//2, h - OUT_RES[1])))
            
            broadcast_frame = pano[y1:y1+OUT_RES[1], x1:x1+OUT_RES[0]]
            
            if broadcast_frame.shape[1] != OUT_RES[0] or broadcast_frame.shape[0] != OUT_RES[1]:
                broadcast_frame = cv2.resize(broadcast_frame, OUT_RES)
                
            out.write(broadcast_frame)
            
            frame_count += 1
            if frame_count % 30 == 0:
                print(f"[*] Frames verarbeitet: {frame_count}")

        cap_l.release()
        cap_r.release()
        out.release()
        print(f"[+] Erfolg! Video gespeichert unter {output_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="VeoClone PC Stitcher")
    parser.add_argument("--left", required=True, help="Pfad zum linken Video")
    parser.add_argument("--right", required=True, help="Pfad zum rechten Video")
    parser.add_argument("--out", default="output_broadcast.mp4", help="Name der Ausgabedatei")
    
    args = parser.parse_args()
    
    processor = VeoProcessor()
    processor.run(args.left, args.right, args.out)
