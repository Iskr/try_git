# Podfile for CallingApp
platform :ios, '15.0'

use_frameworks!

target 'CallingApp' do
  # WebRTC for iOS
  pod 'GoogleWebRTC', '~> 1.1.31999'

  # Network & WebSocket
  pod 'Starscream', '~> 4.0.6'

  # Reactive programming (optional, but helpful)
  pod 'RxSwift', '~> 6.6.0'
  pod 'RxCocoa', '~> 6.6.0'
end

post_install do |installer|
  installer.pods_project.targets.each do |target|
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
    end
  end
end
