// =====================================================
//  衛教模式 (Education Mode) + BLE — 一份韌體同時送 USB + 藍芽
//  - 接 USB 就一直跑、一直打印（電腦網頁版用 Web Serial 收）
//  - 同時開藍芽廣播，手機網頁版用 Web Bluetooth 收
//  - USB 與 BLE 送「完全相同」的 [FFT] 行，所以網頁端 parseFFTLine 不用改
//  - 沒有 LED / 蜂鳴器 / 按鈕 / 自動關機
//
//  藍芽採用 Nordic UART Service (NUS)，這是 Web Bluetooth 最通用的組合：
//    Service UUID              : 6E400001-B5A3-F393-E0A9-E50E24DCCA9E
//    TX Characteristic (notify): 6E400003-B5A3-F393-E0A9-E50E24DCCA9E  ← 裝置推資料給手機
//    RX Characteristic (write) : 6E400002-B5A3-F393-E0A9-E50E24DCCA9E  ← 手機寫給裝置（本專案沒用到，保留）
//  藍芽裝置名稱：SmartInhaler
//
//  需要的函式庫：ESP32 BLE Arduino（安裝 ESP32 開發板套件後內建）、arduinoFFT
//  使用方式：把這個檔案的內容放進 src/main.cpp 再燒錄
// =====================================================

#include <Arduino.h>
#include <driver/i2s.h>
#include <arduinoFFT.h>
#include "esp32_inhaler_model.h"  // ML模型（只用回歸估流量）

// ---- BLE ----
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ==================== 腳位與參數設定 ====================
#define I2S_WS      15
#define I2S_BCLK    14
#define I2S_SD      32

#define SAMPLING_FREQUENCY 44100
#define SAMPLE_BLOCK_SIZE  1024

// ==================== 氣流判斷門檻（可調）====================
#define FLOW_ENERGY_THRESHOLD  574000.0

// ==================== 電源控制（電池 + 按鈕自鎖）====================
// 硬體為「按鈕觸發 + 自鎖電路」：按一下按鈕先給 ESP32 短暫供電，
// ESP32 一開機就把 keepAlivePin 拉 HIGH 接管供電，手放開也不斷電。
// 關機＝把 keepAlivePin 拉 LOW（killPower），切斷自鎖，裝置整個斷電。
// 腳位取自正式版韌體：
#define keepAlivePin  25          // 供電自鎖腳（HIGH 保持供電 / LOW 斷電）
#define keep          HIGH
#define killPower     (!keep)
#define buttonPin     13          // 按鈕（按下為 HIGH，本 demo 僅供辨識，不做長按關機）
#define buttonON      HIGH

// 閒置自動關機：持續「沒有氣流」超過這個時間就自動斷電（省電、避免忘了關）
// 有氣流（有人在吹）就會一直重置計時。想調整就改這一行。
#define IDLE_SHUTDOWN_MS  (5UL * 60UL * 1000UL)   // 預設 5 分鐘
unsigned long lastActiveMs = 0;   // 最後一次偵測到氣流的時間

// ==================== 蜂鳴器（開機提示音）====================
// 取自正式版：GPIO4，無源蜂鳴器，用 ESP32 LEDC PWM 發聲。
#define buzzer      4
int buzzerFreq = 2000;
int buzzerChannel = 0;
int buzzerResolution = 8;

// ==================== WS2812 LED（開機亮燈）====================
// 取自正式版 v4.4：GPIO27，單顆 WS2812B，3V3 供電。
#include <Adafruit_NeoPixel.h>
#define pixelsPin       27
#define pixelsQuantity  1
#define ledBrightness   250
Adafruit_NeoPixel Pixels(pixelsQuantity, pixelsPin, NEO_GRB + NEO_KHZ800);
// 開機亮燈顏色（綠）。想換色改這三個 RGB 值即可。
#define LED_R 0
#define LED_G 255
#define LED_B 0

// ==================== BLE UUID / 名稱 ====================
#define BLE_DEVICE_NAME         "SmartInhaler"
#define NUS_SERVICE_UUID        "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_CHARACTERISTIC_RX   "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define NUS_CHARACTERISTIC_TX   "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

BLEServer*         pServer   = nullptr;
BLECharacteristic* pTxChar   = nullptr;
bool bleConnected = false;

// 連線狀態回呼：斷線後重新開始廣播，手機才能再次找到
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* s) override {
    bleConnected = true;
    Serial.println("[BLE] connected");
  }
  void onDisconnect(BLEServer* s) override {
    bleConnected = false;
    lastActiveMs = millis();   // 斷線後重新開始計閒置時間，避免立刻被判超時關機
    Serial.println("[BLE] disconnected, restart advertising");
    BLEDevice::startAdvertising();
  }
};

// ==================== 物件與變數初始化 ====================
ArduinoFFT<double> FFT = ArduinoFFT<double>();

double vReal[SAMPLE_BLOCK_SIZE];
double vImag[SAMPLE_BLOCK_SIZE];
int32_t i2s_buffer[SAMPLE_BLOCK_SIZE];

unsigned long lastMillis = 0;

#define NUM_BANDS 20
double freqBands[NUM_BANDS];

float fft_data[20];
float ml_flow_rate = 0.0f;
double lowFreqEnergy = 0;
bool hasFlow = false;

// ==================== 子程式宣告 ====================
void initI2S();
void initBLE();
void bleSendLine(const String& line);
void buzzerInit();
void playStartupSound();
void ledInit();
void ledOn();

// ==================== Setup ====================
void setup() {
  // ★ 最優先：開機自鎖。一上電立刻接管供電，否則按鈕放開就斷電開不了機。
  pinMode(keepAlivePin, OUTPUT);
  digitalWrite(keepAlivePin, keep);   // 拉 HIGH 保持供電
  pinMode(buttonPin, INPUT);

  Serial.begin(115200);
  delay(500);

  lastActiveMs = millis();            // 開機當下先重置閒置計時

  buzzerInit();                       // 蜂鳴器初始化
  playStartupSound();                 // ★ 開機提示音：嗶嗶兩聲，代表開機成功
  ledInit();                          // LED 初始化
  ledOn();                            // ★ 開機後維持亮燈（綠）

  initI2S();
  delay(200);
  initBLE();
  delay(200);

  Serial.println("=== Inhaler Education Mode (USB + BLE) ===");
  Serial.println("USB: Web Serial / BLE: Web Bluetooth (SmartInhaler)");
  Serial.print("Flow energy threshold = ");
  Serial.println(FLOW_ENERGY_THRESHOLD, 0);
  Serial.println("==========================================");
}

// ==================== Loop ====================
void loop() {
  // ========== 音頻採集與FFT ==========
  size_t bytes_read;
  i2s_read(I2S_NUM_0, &i2s_buffer, sizeof(i2s_buffer), &bytes_read, portMAX_DELAY);
  int samples_count = bytes_read / sizeof(int32_t);

  for (int i = 0; i < samples_count; i++) {
    vReal[i] = (double)(i2s_buffer[i] >> 14);
    vImag[i] = 0.0;
  }

  FFT.dcRemoval(vReal, samples_count);
  FFT.windowing(vReal, samples_count, FFT_WIN_TYP_HAMMING, FFT_FORWARD);
  FFT.compute(vReal, vImag, samples_count, FFT_FORWARD);
  FFT.complexToMagnitude(vReal, vImag, samples_count);

  for (int j = 0; j < NUM_BANDS; j++) {
    freqBands[j] = 0;
  }

  int num_bins = samples_count / 2;
  for (int i = 2; i < num_bins; i++) {
    double freq = (i * SAMPLING_FREQUENCY) / SAMPLE_BLOCK_SIZE;
    if (freq >= 1000.0 && freq < 21000.0) {
      int bandIndex = (int)((freq - 1000.0) / 1000.0);
      if (bandIndex >= 0 && bandIndex < NUM_BANDS) {
        freqBands[bandIndex] += vReal[i];
      }
    }
  }

  // ========== 每 100ms 打印/送出一次 ==========
  if (millis() - lastMillis >= 100) {
    lastMillis = millis();

    // 組出 [FFT] 行（USB 與 BLE 共用同一份字串，確保格式一致）
    String fftLine = "[FFT] ";
    for (int j = 0; j < NUM_BANDS; j++) {
      fftLine += String(j + 1);
      fftLine += "k:";
      fftLine += String((long)freqBands[j]);
      if (j < NUM_BANDS - 1) fftLine += " | ";
    }

    // USB 輸出（電腦網頁版）
    Serial.println(fftLine);
    // BLE 輸出（手機網頁版）—— 送同一行，結尾補 \n 方便網頁端切行
    bleSendLine(fftLine);

    // 算低頻能量，判斷有無氣流
    lowFreqEnergy = freqBands[0] + freqBands[1] + freqBands[2]
                  + freqBands[3] + freqBands[4];
    hasFlow = (lowFreqEnergy > FLOW_ENERGY_THRESHOLD);

    if (hasFlow) {
      lastActiveMs = millis();        // 有人在吹 → 重置閒置關機計時
      for (int i = 0; i < 20; i++) {
        fft_data[i] = (float)freqBands[i];
      }
      uint8_t dummy_inhale;
      uint8_t dummy_conf;
      predict_all(fft_data, &dummy_inhale, &dummy_conf, &ml_flow_rate);
    } else {
      ml_flow_rate = 0.0f;
    }

    // [DETECT] 行（維持原本 USB 輸出；BLE 不送這行，網頁端本來就不用它）
    Serial.print("[DETECT] LowEnergy=");
    Serial.print((long)lowFreqEnergy);
    Serial.print(" | Flow=");
    Serial.print(hasFlow ? "YES" : "no ");
    if (hasFlow) {
      Serial.print(" | Est=");
      Serial.print(ml_flow_rate, 1);
      Serial.print(" L/min");
    }
    Serial.println();
  }

  // ========== 閒置自動關機 ==========
  // 條件：距離最後一次有氣流已超過 IDLE_SHUTDOWN_MS。
  // 為避免 demo 進行到一半斷電，只有在「藍芽未連線」時才會自動關機；
  // 一旦手機連上藍芽，就視為使用中，不自動關（斷線後才重新開始計時）。
  if (!bleConnected && (millis() - lastActiveMs > IDLE_SHUTDOWN_MS)) {
    Serial.println("[POWER] idle timeout, shutting down...");
    Pixels.clear(); Pixels.show();           // 熄燈，視覺上代表關機
    delay(50);
    digitalWrite(keepAlivePin, killPower);   // 切斷自鎖 → 斷電關機
    delay(2000);                             // 等待硬體斷電
  }
}

// ==================== BLE 送一行（自動分包）====================
// BLE 單次 notify 受 MTU 限制；我們已在 initBLE() 請求較大的 MTU，
// 但為保險，這裡仍以分段方式送出，每段結尾在最後一段補 \n。
void bleSendLine(const String& line) {
  if (!bleConnected || pTxChar == nullptr) return;

  String payload = line + "\n";           // 換行讓網頁端好切行
  const int CHUNK = 180;                   // 單段大小，配合 MTU（<協商後的 MTU-3）
  int len = payload.length();
  for (int off = 0; off < len; off += CHUNK) {
    int n = min(CHUNK, len - off);
    pTxChar->setValue((uint8_t*)(payload.c_str() + off), n);
    pTxChar->notify();
    delay(3);                              // 給協定堆疊一點時間，避免塞爆
  }
}

// ==================== BLE 初始化 ====================
void initBLE() {
  BLEDevice::init(BLE_DEVICE_NAME);

  // 請求較大的 MTU，讓一行 FFT 盡量少分段（手機端會協商實際值）
  BLEDevice::setMTU(247);

  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService* pService = pServer->createService(NUS_SERVICE_UUID);

  // TX：裝置 -> 手機（notify）
  pTxChar = pService->createCharacteristic(
      NUS_CHARACTERISTIC_TX,
      BLECharacteristic::PROPERTY_NOTIFY);
  pTxChar->addDescriptor(new BLE2902());

  // RX：手機 -> 裝置（write）；本專案沒用到，保留以符合 NUS 標準
  BLECharacteristic* pRxChar = pService->createCharacteristic(
      NUS_CHARACTERISTIC_RX,
      BLECharacteristic::PROPERTY_WRITE);
  (void)pRxChar;

  pService->start();

  BLEAdvertising* pAdv = BLEDevice::getAdvertising();
  pAdv->addServiceUUID(NUS_SERVICE_UUID);
  pAdv->setScanResponse(true);
  pAdv->setMinPreferred(0x06);
  pAdv->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("[BLE] advertising as SmartInhaler");
}

// ==================== 蜂鳴器 ====================
void buzzerInit() {
  ledcSetup(buzzerChannel, buzzerFreq, buzzerResolution);
  ledcAttachPin(buzzer, buzzerChannel);
}

// 開機提示音：2000Hz「嗶—嗶—」兩聲（沿用正式版 startUpBuzzer 的音色）
void playStartupSound() {
  for (int i = 0; i < 2; i++) {
    ledcWrite(buzzerChannel, 125);      // 音量（duty）
    ledcWriteTone(buzzerChannel, 2000); // 頻率
    delay(50);
    ledcWrite(buzzerChannel, 0);
    ledcWriteTone(buzzerChannel, 0);
    delay(50);
  }
}

// ==================== WS2812 LED ====================
void ledInit() {
  Pixels.begin();
  Pixels.setBrightness(ledBrightness);
  Pixels.clear();
  Pixels.show();
}

// 開機後維持亮燈（顏色由上方 LED_R/G/B 決定）
void ledOn() {
  Pixels.setBrightness(ledBrightness);
  Pixels.setPixelColor(0, Pixels.Color(LED_R, LED_G, LED_B));
  Pixels.show();
}

// ==================== I2S初始化 ====================
void initI2S() {
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLING_FREQUENCY,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = i2s_comm_format_t(I2S_COMM_FORMAT_STAND_I2S),
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 8,
    .dma_buf_len = 128,
    .use_apll = false
  };

  i2s_pin_config_t pin_config = {
    .bck_io_num = I2S_BCLK,
    .ws_io_num = I2S_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = I2S_SD
  };

  i2s_driver_install(I2S_NUM_0, &i2s_config, 0, NULL);
  i2s_set_pin(I2S_NUM_0, &pin_config);
}
